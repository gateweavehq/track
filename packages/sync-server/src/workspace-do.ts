import { DurableObject } from "cloudflare:workers";
import {
	CloseCode,
	type Comment,
	clientMessage,
	type GitHubConnection,
	type HelloMessage,
	ISSUE_STATUSES,
	type Issue,
	type IssueRelation,
	isAdminRole,
	MEMBER_ROLES,
	mutationSchema,
	type NotificationSettings,
	notificationSettingsPatch,
	PING,
	PONG,
	PROTOCOL_VERSION,
	type Proposal,
	type PullRequest,
	type RejectReason,
	type ServerMessage,
	type Snapshot,
	type Webhook,
	type WebhookInput,
	type WebhookPatch,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "../drizzle/migrations";
import { advanceCycles, nextCycleChange } from "./cycles";
import * as schema from "./db/schema";
import {
	applyGitHubDelivery,
	createGitHubConnection,
	deleteGitHubConnection,
	githubDelivery,
	listGitHubConnections,
	rotateGitHubSecret,
	verifyGitHubDelivery,
} from "./github";
import {
	compact,
	currentVersion,
	oplogFloor,
	opsSince,
	type RetentionPolicy,
	type WriteResult,
} from "./log";
import { applyMutation } from "./mutations";
import {
	type InboxDigest,
	nextDigestAt,
	readSettings,
	takeDueDigests,
	unsubscribe,
	updateSettings,
} from "./notifications";
import { issueProposals } from "./proposals";
import {
	type Directory,
	findComments,
	findIssueById,
	findIssueByKey,
	findIssues,
	findPullRequests,
	findRelations,
	type IssueQuery,
	lastSortOrder,
	MAX_QUERY_LIMIT,
	readDirectory,
} from "./queries";
import { MutationRejected } from "./rejected";
import { nextReminderAt, remindDue } from "./reminders";
import {
	activeMember,
	type Db,
	type MemberProfile,
	readSnapshot,
	removeMember,
	upsertMember,
} from "./state";
import {
	createWebhook,
	deleteWebhook,
	deliverDue,
	listWebhooks,
	nextDeliveryAt,
	pruneDeliveries,
	queueTest,
	renameLink,
	rotateSecret,
	saveLink,
	type Transact,
	updateWebhook,
	type WebhookList,
	type WorkspaceLink,
	workspaceLink,
} from "./webhooks";

/**
 * Header carrying the verified member on socket requests. The Durable Object is only reachable
 * through the app worker's binding, which sets this after checking the session and membership.
 */
export const MEMBER_HEADER = "x-track-member";

/**
 * Header carrying the workspace's link (its id, slug and the app's origin) on socket requests,
 * which the gateway knows from the request. Emails link to the workspace with it.
 */
export const LINK_HEADER = "x-track-link";

export const RETENTION: RetentionPolicy = { minOps: 10_000, minAgeMs: 30 * 24 * 60 * 60 * 1000 };
const COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** When compaction is next due. The alarm also sends webhooks, so it runs more often than that. */
const COMPACTION_DUE_KEY = "compaction_due";
const OPS_PAGE_SIZE = 500;

const memberProfile = z.object({
	id: z.string().min(1),
	name: z.string(),
	email: z.string(),
	image: z.string().nullable(),
	role: z.enum(MEMBER_ROLES),
});

const shortId = z.string().min(1).max(64);

const issueQuery = z.object({
	teamId: shortId.optional(),
	statuses: z.array(z.enum(ISSUE_STATUSES)).optional(),
	assigneeId: shortId.nullable().optional(),
	projectId: shortId.optional(),
	cycleIds: z.array(shortId).max(100).optional(),
	parentId: shortId.optional(),
	labelId: shortId.optional(),
	text: z.string().max(200).optional(),
	limit: z.number().int().min(1).max(MAX_QUERY_LIMIT),
});

/**
 * The outcome of {@link WorkspaceDO.mutate}, mirroring a socket client's ack or reject. `proposed`
 * is what an agent's mutation proposed instead of making, for the agent to be told.
 */
export type MutateResult =
	| { ok: true; version: number; proposed: Proposal[] }
	| { ok: false; reason: RejectReason; message: string };

/**
 * The outcome of managing webhooks or GitHub connections, which only admins may do, or a
 * person's own notification settings.
 */
export type WebhookResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: RejectReason; message: string };

/**
 * How a GitHub delivery went, as the HTTP status to answer GitHub with: accepted, not shaped like
 * a delivery, a signature that does not match, or no such connection.
 */
export type GitHubDeliveryResult = { status: 202 | 400 | 401 | 404 };

/** Per-socket state. Stored as an attachment so it survives hibernation. */
interface SocketState {
	userId: string;
	clientId: string | null;
	/** True once the socket has said hello and been caught up; only live sockets get broadcasts. */
	live: boolean;
	/** The last version the socket has been sent a delta through, so the next starts after it. */
	through: number;
}

/** One instance per workspace. Owns the workspace's data and fans changes out to clients. */
export class WorkspaceDO extends DurableObject {
	readonly #db: Db;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#db = drizzle(ctx.storage, { schema });
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			await migrate(this.#db, migrations);
			if ((await ctx.storage.getAlarm()) === null) {
				await ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
			}
		});
	}

	// RPC, called by the app worker after it has verified membership.

	/** Full workspace state. Also refreshes the requesting member's profile. */
	snapshot(member: MemberProfile): Snapshot {
		const profile = memberProfile.parse(member);
		this.#write(() => upsertMember(this.#db, profile, Date.now()));
		return readSnapshot(this.#db, profile.id);
	}

	syncMember(member: MemberProfile): void {
		this.#write(() => upsertMember(this.#db, memberProfile.parse(member), Date.now()));
	}

	removeMember(userId: string): void {
		this.#write(() => removeMember(this.#db, userId, Date.now()));
		for (const ws of this.ctx.getWebSockets()) {
			if (socketState(ws).userId === userId) {
				ws.close(CloseCode.Forbidden, "Removed from workspace");
			}
		}
	}

	// RPC for server-side clients, such as MCP tools acting for a member. They read slices of
	// the workspace instead of keeping a replica, and write through the same mutations.

	/** Teams and members, for resolving keys and names. */
	directory(): Directory {
		return readDirectory(this.#db);
	}

	issues(query: IssueQuery): Issue[] {
		return findIssues(this.#db, issueQuery.parse(query));
	}

	issue(id: string): Issue | null {
		return findIssueById(this.#db, shortId.parse(id)) ?? null;
	}

	issueByKey(teamKey: string, number: number): Issue | null {
		return (
			findIssueByKey(this.#db, z.string().parse(teamKey), z.number().int().parse(number)) ?? null
		);
	}

	comments(issueId: string): Comment[] {
		return findComments(this.#db, shortId.parse(issueId));
	}

	/** An issue's relations, from either side. */
	relations(issueId: string): IssueRelation[] {
		return findRelations(this.#db, shortId.parse(issueId));
	}

	/** An issue's open proposals, oldest first. */
	proposals(issueId: string): Proposal[] {
		return issueProposals(this.#db, shortId.parse(issueId));
	}

	/** The pull requests on GitHub that mention an issue, oldest first. */
	pullRequests(issueId: string): PullRequest[] {
		return findPullRequests(this.#db, shortId.parse(issueId));
	}

	lastSortOrder(): string | null {
		return lastSortOrder(this.#db);
	}

	/**
	 * Applies a mutation exactly as a socket client's would be: same validation, same
	 * idempotency by mutation id, same broadcast. Also refreshes the member's profile.
	 */
	mutate(member: MemberProfile, clientId: string, mutationId: string, body: unknown): MutateResult {
		const profile = memberProfile.parse(member);
		shortId.parse(clientId);
		shortId.parse(mutationId);
		this.#write(() => upsertMember(this.#db, profile, Date.now()));
		const row = activeMember(this.#db, profile.id);
		if (!row) return { ok: false, reason: "forbidden", message: "Not a workspace member" };

		const mutation = mutationSchema.safeParse(body);
		if (!mutation.success) {
			return { ok: false, reason: "invalid", message: z.prettifyError(mutation.error) };
		}
		try {
			const result = this.#write(() =>
				applyMutation(this.#db, { member: row, clientId }, mutationId, mutation.data, Date.now()),
			);
			return { ok: true, version: result.version, proposed: result.proposed ?? [] };
		} catch (error) {
			if (!(error instanceof MutationRejected)) throw error;
			return { ok: false, reason: error.reason, message: error.message };
		}
	}

	// RPC for webhook settings. The gateway passes the verified member, as for `mutate`, and the
	// workspace's current link, since only the gateway knows the slug and the app's origin.

	/** The workspace's webhooks and their latest deliveries. */
	webhooks(member: MemberProfile): WebhookResult<WebhookList> {
		return this.#manage(member, () => listWebhooks(this.#db));
	}

	/** Adds a webhook. Its secret is in the result, and never again. */
	createWebhook(
		member: MemberProfile,
		link: WorkspaceLink,
		input: WebhookInput,
	): WebhookResult<{ webhook: Webhook; secret: string }> {
		return this.#manage(member, () => {
			saveLink(this.#db, link);
			return createWebhook(this.#db, link, input, Date.now());
		});
	}

	updateWebhook(
		member: MemberProfile,
		link: WorkspaceLink,
		id: string,
		patch: WebhookPatch,
	): WebhookResult<Webhook> {
		return this.#manage(member, () => {
			saveLink(this.#db, link);
			return updateWebhook(this.#db, link, shortId.parse(id), patch, Date.now());
		});
	}

	deleteWebhook(member: MemberProfile, id: string): WebhookResult<null> {
		return this.#manage(member, () => {
			deleteWebhook(this.#db, shortId.parse(id));
			return null;
		});
	}

	rotateWebhookSecret(member: MemberProfile, id: string): WebhookResult<string> {
		return this.#manage(member, () => rotateSecret(this.#db, shortId.parse(id), Date.now()));
	}

	/** Sends the webhook a `webhook.test` event. */
	testWebhook(member: MemberProfile, link: WorkspaceLink, id: string): WebhookResult<null> {
		const result = this.#manage(member, () => {
			saveLink(this.#db, link);
			queueTest(this.#db, shortId.parse(id), Date.now());
			return null;
		});
		if (result.ok) this.#alarmSoon();
		return result;
	}

	// RPC for GitHub connections. Settings come through a gateway with the verified member, as for
	// webhooks. Deliveries come from GitHub through the GitHub gateway, which knows nothing about
	// them: they are authenticated here, by their signature, before their body is read.

	githubConnections(member: MemberProfile): WebhookResult<GitHubConnection[]> {
		return this.#manage(member, () => listGitHubConnections(this.#db), "GitHub connections");
	}

	/** Adds a connection. Its secret is in the result, and never again. */
	createGitHubConnection(
		member: MemberProfile,
	): WebhookResult<{ connection: GitHubConnection; secret: string }> {
		return this.#manage(
			member,
			() => createGitHubConnection(this.#db, member.id, Date.now()),
			"GitHub connections",
		);
	}

	rotateGitHubSecret(member: MemberProfile, id: string): WebhookResult<string> {
		return this.#manage(
			member,
			() => rotateGitHubSecret(this.#db, shortId.parse(id)),
			"GitHub connections",
		);
	}

	deleteGitHubConnection(member: MemberProfile, id: string): WebhookResult<null> {
		return this.#manage(
			member,
			() => {
				deleteGitHubConnection(this.#db, shortId.parse(id));
				return null;
			},
			"GitHub connections",
		);
	}

	// RPC for a person's own notification settings. Agents have none: webhooks tell them.

	notificationSettings(member: MemberProfile): WebhookResult<NotificationSettings> {
		return this.#own(member, (id) => readSettings(this.#db, id));
	}

	updateNotificationSettings(
		member: MemberProfile,
		patch: unknown,
	): WebhookResult<NotificationSettings> {
		const parsed = notificationSettingsPatch.safeParse(patch);
		if (!parsed.success) {
			return { ok: false, reason: "invalid", message: "Invalid notification settings" };
		}
		return this.#own(member, (id) => updateSettings(this.#db, id, parsed.data, Date.now()));
	}

	/**
	 * Turns a member's email off, from the link in an email. The gateway has checked the link's
	 * signature, which stands in for a session. False when they are no longer a member.
	 */
	unsubscribe(memberId: string): boolean {
		const id = shortId.parse(memberId);
		return this.ctx.storage.transactionSync(() => {
			const member = activeMember(this.#db, id);
			if (!member || member.role === "agent") return false;
			unsubscribe(this.#db, id, Date.now());
			return true;
		});
	}

	/**
	 * Sends a member a digest of the inbox news they left unread. Track's app sends it as email;
	 * without an app that does, nothing is sent. Called by the alarm, outside any transaction, at
	 * most once per digest: a failure loses that email rather than sending it twice.
	 */
	protected async sendInboxDigest(_digest: InboxDigest): Promise<void> {}

	/** A delivery from a GitHub connection's webhook. */
	async github(input: unknown): Promise<GitHubDeliveryResult> {
		const parsed = githubDelivery.safeParse(input);
		if (!parsed.success) return { status: 400 };
		const delivery = parsed.data;
		const verified = await verifyGitHubDelivery(this.#db, delivery);
		if (verified === null) return { status: 404 };
		if (!verified) return { status: 401 };
		this.#write(() => applyGitHubDelivery(this.#db, delivery, Date.now()));
		return { status: 202 };
	}

	/** Follows a change of the workspace's slug, so webhook payloads link to the right place. */
	relink(slug: string): void {
		this.ctx.storage.transactionSync(() => renameLink(this.#db, z.string().min(1).parse(slug)));
	}

	/** Permanently deletes the workspace's data. Called after the workspace itself is deleted. */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.Forbidden, "Workspace deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	// WebSocket lifecycle

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/socket" || request.headers.get("Upgrade") !== "websocket") {
			return new Response("Not found", { status: 404 });
		}
		const member = memberProfile.safeParse(parseJson(request.headers.get(MEMBER_HEADER)));
		if (!member.success) return new Response("Missing member", { status: 400 });

		this.#write(() => upsertMember(this.#db, member.data, Date.now()));
		const link = workspaceLink.safeParse(parseJson(request.headers.get(LINK_HEADER)));
		if (link.success) this.ctx.storage.transactionSync(() => saveLink(this.#db, link.data));

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			userId: member.data.id,
			clientId: null,
			live: false,
			through: 0,
		} satisfies SocketState);
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		const message = typeof raw === "string" ? clientMessage.safeParse(parseJson(raw)) : null;
		if (!message?.success) {
			ws.close(CloseCode.InvalidMessage, "Invalid message");
			return;
		}
		try {
			if (message.data.type === "hello") this.#hello(ws, message.data);
			else this.#mutate(ws, message.data.id, message.data.mutation);
		} catch (error) {
			// The client reconnects and resends pending mutations; mutation ids keep that safe.
			console.error("sync: unexpected error", error);
			ws.close(1011, "Internal error");
		}
	}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed, or the code is one that cannot be sent back (1005/1006).
		}
	}

	/**
	 * Moves teams' cycles on at their boundaries, reminds assignees of issues due today, compacts
	 * the log when that is due, and sends the webhook deliveries and the inbox digests that are.
	 */
	override async alarm(): Promise<void> {
		const now = Date.now();
		// Deliveries this queues go out below, in this same run.
		this.#broadcast(this.ctx.storage.transactionSync(() => advanceCycles(this.#db, now)));
		this.#broadcast(this.ctx.storage.transactionSync(() => remindDue(this.#db, now)));
		if (now >= this.#compactionDue()) {
			this.ctx.storage.transactionSync(() => {
				compact(this.#db, now, RETENTION);
				pruneDeliveries(this.#db, now);
				const value = String(now + COMPACTION_INTERVAL_MS);
				this.#db
					.insert(schema.meta)
					.values({ key: COMPACTION_DUE_KEY, value })
					.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
					.run();
			});
		}
		const transact: Transact = (fn) => this.ctx.storage.transactionSync(fn);
		const more = await deliverDue(this.#db, transact);
		const digests = this.ctx.storage.transactionSync(() => takeDueDigests(this.#db, Date.now()));
		await Promise.all(
			digests.map((digest) =>
				this.sendInboxDigest(digest).catch((error) => {
					console.error("email: inbox digest not sent", error);
				}),
			),
		);
		// Cycles were just moved on and reminders sent, so one that is still due is a clock
		// disagreement: look again in a minute rather than straight away.
		const soon = (at: number | null) =>
			at === null ? Number.POSITIVE_INFINITY : Math.max(at, Date.now() + 60_000);
		const next = more
			? Date.now()
			: Math.min(
					this.#compactionDue(),
					nextDeliveryAt(this.#db) ?? Number.POSITIVE_INFINITY,
					nextDigestAt(this.#db) ?? Number.POSITIVE_INFINITY,
					soon(nextCycleChange(this.#db, Date.now())),
					soon(nextReminderAt(this.#db, Date.now())),
				);
		await this.ctx.storage.setAlarm(next);
	}

	// Message handlers. Each runs synchronously, so no other event can interleave with it.

	#hello(ws: WebSocket, hello: HelloMessage): void {
		if (hello.protocol !== PROTOCOL_VERSION) {
			ws.close(CloseCode.ProtocolMismatch, `Server speaks protocol ${PROTOCOL_VERSION}`);
			return;
		}
		const head = currentVersion(this.#db);
		if (hello.since > head || hello.since < oplogFloor(this.#db)) {
			send(ws, { type: "reset" });
			return;
		}

		const state = socketState(ws);
		let cursor = hello.since;
		while (cursor < head) {
			const ops = opsSince(this.#db, cursor, OPS_PAGE_SIZE, state.userId);
			const last = ops.at(-1);
			// A short page reaches the head: the versions after its last op were for others.
			const to = last && ops.length === OPS_PAGE_SIZE ? last.version : head;
			send(ws, { type: "delta", from: cursor + 1, to, ops });
			cursor = to;
		}

		ws.serializeAttachment({
			...state,
			clientId: hello.clientId,
			live: true,
			through: head,
		} satisfies SocketState);
		send(ws, { type: "ready", version: head });
	}

	#mutate(ws: WebSocket, id: string, body: unknown): void {
		const state = socketState(ws);
		if (!state.live || !state.clientId) {
			ws.close(CloseCode.InvalidMessage, "Send hello before mutating");
			return;
		}
		const member = activeMember(this.#db, state.userId);
		if (!member) {
			ws.close(CloseCode.Forbidden, "Not a workspace member");
			return;
		}
		const mutation = mutationSchema.safeParse(body);
		if (!mutation.success) {
			send(ws, { type: "reject", id, reason: "invalid", message: z.prettifyError(mutation.error) });
			return;
		}

		try {
			const clientId = state.clientId;
			const result = this.#write(() =>
				applyMutation(this.#db, { member, clientId }, id, mutation.data, Date.now()),
			);
			send(ws, { type: "ack", id, version: result.version });
		} catch (error) {
			if (!(error instanceof MutationRejected)) throw error;
			send(ws, { type: "reject", id, reason: error.reason, message: error.message });
		}
	}

	/** Runs an admin's change to the workspace's settings in a transaction. Anyone else is refused. */
	#manage<T>(member: MemberProfile, fn: () => T, what = "webhooks"): WebhookResult<T> {
		const profile = memberProfile.parse(member);
		this.#write(() => upsertMember(this.#db, profile, Date.now()));
		const row = activeMember(this.#db, profile.id);
		if (!row || !isAdminRole(row.role)) {
			return {
				ok: false,
				reason: "forbidden",
				message: `Only workspace admins can manage ${what}`,
			};
		}
		try {
			return { ok: true, value: this.ctx.storage.transactionSync(fn) };
		} catch (error) {
			if (!(error instanceof MutationRejected)) throw error;
			return { ok: false, reason: error.reason, message: error.message };
		}
	}

	/** Runs a person's change to their own settings in a transaction. Agents are refused. */
	#own<T>(member: MemberProfile, fn: (id: string) => T): WebhookResult<T> {
		const profile = memberProfile.parse(member);
		this.#write(() => upsertMember(this.#db, profile, Date.now()));
		const row = activeMember(this.#db, profile.id);
		if (!row || row.role === "agent") {
			return { ok: false, reason: "forbidden", message: "Agents have no notifications" };
		}
		return { ok: true, value: this.ctx.storage.transactionSync(() => fn(profile.id)) };
	}

	/**
	 * Has the alarm run now, rather than at its next scheduled time: to send queued deliveries, to
	 * plan around a change to a team's cycles, or to plan the next email.
	 */
	#alarmSoon(): void {
		this.ctx.storage.setAlarm(Date.now()).catch((error) => {
			console.error("sync: could not schedule the alarm", error);
		});
	}

	/** Workspaces made before this key existed scheduled compaction without it: due now. */
	#compactionDue(): number {
		const row = this.#db
			.select()
			.from(schema.meta)
			.where(eq(schema.meta.key, COMPACTION_DUE_KEY))
			.get();
		return row ? Number(row.value) : 0;
	}

	/** Runs a write in a transaction, then broadcasts its ops to every live socket. */
	#write<T extends WriteResult>(fn: () => T): T {
		const result = this.ctx.storage.transactionSync(fn);
		if (result.queued || result.wake) this.#alarmSoon();
		this.#broadcast(result);
		return result;
	}

	/**
	 * Sends a write's ops to every live socket, leaving out other members' private ones. A socket
	 * none of them are for gets nothing; its next delta starts where its last one ended.
	 */
	#broadcast(result: Pick<WriteResult, "version" | "ops" | "audience">): void {
		if (result.ops.length === 0) return;
		const { audience } = result;
		const members = new Set(audience?.values());
		const shared = audience ? result.ops.filter((op) => !audience.has(op.version)) : result.ops;
		// Sockets that are up to date and get the same ops share one payload.
		const payloads = new Map<string, string>();
		for (const ws of this.ctx.getWebSockets()) {
			const state = socketState(ws);
			if (!state.live) continue;
			const own = members.has(state.userId);
			const ops = own
				? result.ops.filter((op) => (audience?.get(op.version) ?? state.userId) === state.userId)
				: shared;
			if (ops.length === 0) continue;
			const from = state.through + 1;
			const key = `${from}:${own ? state.userId : ""}`;
			let payload = payloads.get(key);
			if (payload === undefined) {
				payload = JSON.stringify({
					type: "delta",
					from,
					to: result.version,
					ops,
				} satisfies ServerMessage);
				payloads.set(key, payload);
			}
			trySend(ws, payload);
			ws.serializeAttachment({ ...state, through: result.version } satisfies SocketState);
		}
	}
}

function socketState(ws: WebSocket): SocketState {
	return ws.deserializeAttachment() as SocketState;
}

function send(ws: WebSocket, message: ServerMessage): void {
	trySend(ws, JSON.stringify(message));
}

function trySend(ws: WebSocket, payload: string): void {
	try {
		ws.send(payload);
	} catch {
		// The socket is closing; the client will catch up after reconnecting.
	}
}

function parseJson(text: string | null): unknown {
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
