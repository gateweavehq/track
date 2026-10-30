import { DurableObject } from "cloudflare:workers";
import {
	CloseCode,
	type Comment,
	clientMessage,
	type HelloMessage,
	ISSUE_STATUSES,
	type Issue,
	isAdminRole,
	MEMBER_ROLES,
	mutationSchema,
	type Op,
	PING,
	PONG,
	PROTOCOL_VERSION,
	type Proposal,
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
import * as schema from "./db/schema";
import { compact, currentVersion, oplogFloor, opsSince, type RetentionPolicy } from "./log";
import { applyMutation } from "./mutations";
import { issueProposals } from "./proposals";
import {
	type Directory,
	findComments,
	findIssueById,
	findIssueByKey,
	findIssues,
	type IssueQuery,
	lastSortOrder,
	MAX_QUERY_LIMIT,
	readDirectory,
} from "./queries";
import { MutationRejected } from "./rejected";
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
} from "./webhooks";

/**
 * Header carrying the verified member on socket requests. The Durable Object is only reachable
 * through the app worker's binding, which sets this after checking the session and membership.
 */
export const MEMBER_HEADER = "x-track-member";

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

/** The outcome of managing webhooks, which only admins may do. */
export type WebhookResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: RejectReason; message: string };

/** Per-socket state. Stored as an attachment so it survives hibernation. */
interface SocketState {
	userId: string;
	clientId: string | null;
	/** True once the socket has said hello and been caught up; only live sockets get broadcasts. */
	live: boolean;
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
		this.#write(() => upsertMember(this.#db, memberProfile.parse(member), Date.now()));
		return readSnapshot(this.#db);
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

	/** An issue's open proposals, oldest first. */
	proposals(issueId: string): Proposal[] {
		return issueProposals(this.#db, shortId.parse(issueId));
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
		if (result.ok) this.#deliverSoon();
		return result;
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

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			userId: member.data.id,
			clientId: null,
			live: false,
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

	/** Compacts the log when that is due, and sends the webhook deliveries that are. */
	override async alarm(): Promise<void> {
		const now = Date.now();
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
		const next = more
			? Date.now()
			: Math.min(this.#compactionDue(), nextDeliveryAt(this.#db) ?? Number.POSITIVE_INFINITY);
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

		let cursor = hello.since;
		while (cursor < head) {
			const ops = opsSince(this.#db, cursor, OPS_PAGE_SIZE);
			const last = ops.at(-1);
			if (!last) break;
			send(ws, { type: "delta", ops });
			cursor = last.version;
		}

		ws.serializeAttachment({
			...socketState(ws),
			clientId: hello.clientId,
			live: true,
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

	/** Runs an admin's webhook change in a transaction. Anyone else is refused. */
	#manage<T>(member: MemberProfile, fn: () => T): WebhookResult<T> {
		const profile = memberProfile.parse(member);
		this.#write(() => upsertMember(this.#db, profile, Date.now()));
		const row = activeMember(this.#db, profile.id);
		if (!row || !isAdminRole(row.role)) {
			return {
				ok: false,
				reason: "forbidden",
				message: "Only workspace admins can manage webhooks",
			};
		}
		try {
			return { ok: true, value: this.ctx.storage.transactionSync(fn) };
		} catch (error) {
			if (!(error instanceof MutationRejected)) throw error;
			return { ok: false, reason: error.reason, message: error.message };
		}
	}

	/** Has the alarm send queued deliveries now, rather than at its next scheduled run. */
	#deliverSoon(): void {
		this.ctx.storage.setAlarm(Date.now()).catch((error) => {
			console.error("webhooks: could not schedule delivery", error);
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
	#write<T extends { ops: Op[]; queued?: number }>(fn: () => T): T {
		const result = this.ctx.storage.transactionSync(fn);
		if (result.queued) this.#deliverSoon();
		if (result.ops.length > 0) {
			const payload = JSON.stringify({ type: "delta", ops: result.ops } satisfies ServerMessage);
			for (const ws of this.ctx.getWebSockets()) {
				if (socketState(ws).live) trySend(ws, payload);
			}
		}
		return result;
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
