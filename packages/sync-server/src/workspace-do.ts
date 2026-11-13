import { DurableObject } from "cloudflare:workers";
import {
	type Activity,
	type ArchivedIssues,
	type ArchivedIssuesPage,
	type AuditAction,
	type AuditDetail,
	type AuditPage,
	type AuditTarget,
	archivedIssuesPageRequest,
	archivedIssuesRequest,
	auditPageRequest,
	CloseCode,
	type Comment,
	clientMessage,
	type GitHubConnection,
	gatewayAuditEvent,
	type HelloMessage,
	type Issue,
	type IssueDetails,
	type IssueRelation,
	isAdminRole,
	issueDetailsRequest,
	MEMBER_ROLES,
	mutationSchema,
	type NotificationSettings,
	notificationSettingsPatch,
	PING,
	PONG,
	PROTOCOL_VERSION,
	type ProjectUpdate,
	type Proposal,
	type PullRequest,
	type RejectReason,
	type ServerMessage,
	type Snapshot,
	statusKey,
	type Webhook,
	type WebhookInput,
	type WebhookPatch,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "../drizzle/migrations";
import { findArchivedIssues, findArchivedIssuesPage, findIssueDetails } from "./archive";
import {
	findGitHubRow,
	findWebhookRow,
	githubTarget,
	pruneAudit,
	readAuditPage,
	recordAudit,
	webhookChanges,
	webhookTarget,
} from "./audit";
import { nextAutomationsAt, runAutomations } from "./automations";
import { type BackupRow, readForBackup } from "./backup";
import { advanceCycles, nextCycleChange } from "./cycles";
import * as schema from "./db/schema";
import { forgetPerson } from "./forget";
import {
	applyGitHubDelivery,
	connectGitHubApp,
	createGitHubConnection,
	deleteGitHubConnection,
	githubDelivery,
	githubInstallation,
	listGitHubConnections,
	rotateGitHubSecret,
	verifyGitHubDelivery,
} from "./github";
import { fileRequest, findIntake, type IntakeTarget, intakeRequest } from "./intake";
import {
	compact,
	currentVersion,
	oplogFloor,
	opsSince,
	type RetentionPolicy,
	type WriteResult,
} from "./log";
import {
	beginImport,
	checkCopy,
	digestTables,
	endImport,
	freezeEnds,
	freezeForMove,
	MOVING_MESSAGE,
	type MoveCursor,
	type MoveManifest,
	type MoveOut,
	type MovePage,
	type MoveRows,
	mayImport,
	moveStateAtStart,
	readForMove,
	sealForMove,
	type Thawed,
	thaw,
	thawAfterMove,
	writeForMove,
} from "./move";
import { applyMutation } from "./mutations";
import {
	type InboxDigest,
	nextDigestAt,
	nextPushAt,
	type PushNotice,
	readSettings,
	takeDueDigests,
	takeDuePushes,
	unsubscribe,
	updateSettings,
} from "./notifications";
import { issueProposals } from "./proposals";
import {
	type Directory,
	findComments,
	findInsightSource,
	findIssueById,
	findIssueByKey,
	findIssues,
	findProjectUpdates,
	findPullRequests,
	findRelations,
	type InsightScope,
	type IssueQuery,
	lastSortOrder,
	MAX_QUERY_LIMIT,
	readDirectory,
} from "./queries";
import { nextRecurringAt, runRecurring } from "./recurring";
import { MutationRejected } from "./rejected";
import { nextReminderAt, remindDue } from "./reminders";
import {
	fileReply,
	findReplyRequest,
	hasRequesterNotices,
	type RequesterNotice,
	requesterReply,
	takeRequesterNotices,
} from "./requesters";
import {
	activeMember,
	type Db,
	type MemberProfile,
	readSnapshot,
	removeMember,
	upsertMember,
} from "./state";
import {
	forgetFileStorage,
	releaseFileStorage,
	reserveFileStorage,
	type StorageReservation,
} from "./storage";
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
 * Header carrying the verified member's id on socket requests. The Durable Object is only reachable
 * through the app worker's binding, which sets this after checking the session and membership.
 *
 * Only the id, because Workers Logs records this request's headers for seven days, and a person's name
 * and address have no business there. The gateway hands those over first with `syncMember`, whose
 * arguments are not logged. A socket can only be opened by `fetch`, so this one request has to stay.
 */
export const MEMBER_HEADER = "x-track-member";

/**
 * Header carrying the workspace's link (its id, slug and the app's origin) on socket requests,
 * which the gateway knows from the request. Emails link to the workspace with it.
 */
export const LINK_HEADER = "x-track-link";

/**
 * Header carrying the session a socket was opened with, its id and when it expires (ms), on socket
 * requests. The gateway checks the session only at the handshake; the object closes the socket
 * when the session ends ({@link WorkspaceDO.endSessions}) or runs out.
 */
export const SESSION_HEADER = "x-track-session";

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

const socketSession = z.object({
	id: z.string().min(1),
	expiresAt: z.number().int(),
});

/** The session a socket was opened with, as the gateway saw it. */
export type SocketSession = z.infer<typeof socketSession>;

const issueQuery = z.object({
	teamId: shortId.optional(),
	statuses: z.array(statusKey).max(100).optional(),
	assigneeId: shortId.nullable().optional(),
	projectId: shortId.optional(),
	cycleIds: z.array(shortId).max(100).optional(),
	parentId: shortId.optional(),
	labelId: shortId.optional(),
	archived: z.boolean().optional(),
	intake: z.boolean().optional(),
	text: z.string().max(200).optional(),
	limit: z.number().int().min(1).max(MAX_QUERY_LIMIT),
});

const storageInput = z.object({
	bytes: z.number().int().nonnegative(),
	limit: z.number().nonnegative(),
	seed: z.number().int().nonnegative().optional(),
});

const insightScope = z.union([
	z.object({ teamId: shortId }).strict(),
	z.object({ projectId: shortId }).strict(),
]);

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
	/** The session the socket was opened with, which the gateway checked at the handshake. */
	sessionId: string;
	/** When that session runs out. A socket's messages are refused from then on. */
	expiresAt: number;
	clientId: string | null;
	/** True once the socket has said hello and been caught up; only live sockets get broadcasts. */
	live: boolean;
	/** The last version the socket has been sent a delta through, so the next starts after it. */
	through: number;
}

/** One instance per workspace. Owns the workspace's data and fans changes out to clients. */
export class WorkspaceDO extends DurableObject {
	readonly #db: Db;
	/**
	 * Where a move (move.ts) has the workspace: frozen while it moves out, sealed once it has, or
	 * taking a move's rows in. Kept in storage too; this saves reading it on every message.
	 */
	#move: "frozen" | "sealed" | "importing" | null = null;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#db = drizzle(ctx.storage, { schema });
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			// A sealed workspace has moved: what it holds waits to be destroyed, and nothing runs.
			this.#move = moveStateAtStart(ctx.storage);
			if (this.#move === "sealed") return;
			await migrate(this.#db, migrations);
			// A half-filled copy runs nothing either, until the move that fills it starts it.
			if (this.#move === null && (await ctx.storage.getAlarm()) === null) {
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

	/**
	 * An issue whole, with its comments, history, open proposals and pull requests, for the page of
	 * an archived one, which replicas hold slim. The gateway passes the verified member, as for the
	 * snapshot. A read writes nothing, so the member must already be one here: someone removed, or
	 * never seen, is refused. An id this workspace has no live issue by, such as another
	 * workspace's, is not found.
	 */
	issueDetails(member: MemberProfile, input: unknown): WebhookResult<IssueDetails> {
		const request = issueDetailsRequest.safeParse(input);
		if (!request.success) return { ok: false, reason: "invalid", message: "Invalid issue id" };
		return this.#read(member, () => {
			const details = findIssueDetails(this.#db, request.data.issueId);
			return details
				? { ok: true, value: details }
				: { ok: false, reason: "not_found", message: "Issue not found" };
		});
	}

	/**
	 * Every archived issue whole, every team's or one's, with their comments and history, in one
	 * answer: what v0.21.0's exports ask for. Kept as it was for that build until a later protocol
	 * bump; newer clients ask for `archivedIssuesPage`. An archive too large for one answer is
	 * `"too_large"`, never cut short: that build would save a short file without a word.
	 */
	archivedIssues(
		member: MemberProfile,
		input: unknown,
	): WebhookResult<ArchivedIssues | "too_large"> {
		const request = archivedIssuesRequest.safeParse(input);
		if (!request.success) return { ok: false, reason: "invalid", message: "Invalid team id" };
		return this.#read(member, () => ({
			ok: true,
			value: findArchivedIssues(this.#db, request.data.teamId),
		}));
	}

	/**
	 * A page of archived issues whole, every team's or one's, with their comments and history, for
	 * exports. Paged so that no answer outgrows the RPC limit, however large the archive.
	 */
	archivedIssuesPage(member: MemberProfile, input: unknown): WebhookResult<ArchivedIssuesPage> {
		const request = archivedIssuesPageRequest.safeParse(input);
		if (!request.success) return { ok: false, reason: "invalid", message: "Invalid archive page" };
		return this.#read(member, () => ({
			ok: true,
			value: findArchivedIssuesPage(this.#db, request.data),
		}));
	}

	syncMember(member: MemberProfile): void {
		this.#write(() => upsertMember(this.#db, memberProfile.parse(member), Date.now()));
	}

	removeMember(userId: string): void {
		this.#write(() => removeMember(this.#db, userId, Date.now()));
		this.#closeSocketsOf(userId);
	}

	/**
	 * Called for someone who deleted their account, whether or not they are still a member here.
	 * The gateway repeats it until it hears that it worked, and doing it twice is harmless.
	 */
	forgetPerson(userId: string): void {
		const id = z.string().min(1).parse(userId);
		this.#write(() => forgetPerson(this.#db, id, Date.now()));
		this.#closeSocketsOf(id);
	}

	#closeSocketsOf(userId: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (socketState(ws).userId === userId) {
				ws.close(CloseCode.Forbidden, "Removed from workspace");
			}
		}
	}

	/**
	 * Closes the user's sockets that were opened with any of these sessions, which have just
	 * ended: signed out, revoked, or ended by a password reset. Their clients sign in again, or
	 * reconnect with the session they have now.
	 */
	endSessions(userId: string, sessionIds: string[]): void {
		const ended = new Set(z.array(z.string()).parse(sessionIds));
		for (const ws of this.ctx.getWebSockets()) {
			const state = socketState(ws);
			if (state.userId === userId && ended.has(state.sessionId)) {
				ws.close(CloseCode.SessionEnded, "Session ended");
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

	/**
	 * Takes `bytes` of the workspace's file quota for an upload, if `limit` allows. The gateway
	 * calls it before storing a file and gives the space back if storing fails.
	 */
	reserveFileStorage(input: { bytes: number; limit: number; seed?: number }): StorageReservation {
		return reserveFileStorage(this.#db, storageInput.parse(input));
	}

	releaseFileStorage(bytes: number): void {
		releaseFileStorage(this.#db, z.number().int().nonnegative().parse(bytes));
	}

	/** Drops the count of the workspace's file bytes, which goes stale while there is no quota. */
	forgetFileStorage(): void {
		forgetFileStorage(this.#db);
	}

	/** A team's or a project's issues and their status changes, for insights. */
	insightSource(scope: InsightScope): { issues: Issue[]; activities: Activity[] } {
		return findInsightSource(this.#db, insightScope.parse(scope));
	}

	/** A live project's updates, the latest first. */
	projectUpdates(projectId: string): ProjectUpdate[] {
		return findProjectUpdates(this.#db, shortId.parse(projectId));
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

	/**
	 * Applies mutations in order, each as {@link mutate} would, and stops at the first that fails,
	 * whose result comes last. For a server writing many at once, such as a demo sandbox's sample
	 * data: a call each would cross to the object's jurisdiction and back every time.
	 */
	mutateMany(
		clientId: string,
		steps: readonly { member: MemberProfile; mutationId: string; body: unknown }[],
	): MutateResult[] {
		const results: MutateResult[] = [];
		const parsed = z
			.array(z.object({ member: memberProfile, mutationId: shortId, body: z.unknown() }))
			.parse(steps);
		for (const { member, mutationId, body } of parsed) {
			const result = this.mutate(member, clientId, mutationId, body);
			results.push(result);
			if (!result.ok) break;
		}
		return results;
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
			const now = Date.now();
			const created = createWebhook(this.#db, link, input, now);
			this.#audit(member, "webhook.created", webhookTarget(created.webhook), now);
			return created;
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
			const now = Date.now();
			const before = findWebhookRow(this.#db, shortId.parse(id));
			const webhook = updateWebhook(this.#db, link, shortId.parse(id), patch, now);
			for (const change of before ? webhookChanges(before, webhook) : []) {
				this.#audit(member, "webhook.updated", webhookTarget(webhook), now, change);
			}
			return webhook;
		});
	}

	deleteWebhook(member: MemberProfile, id: string): WebhookResult<null> {
		return this.#manage(member, () => {
			const before = findWebhookRow(this.#db, shortId.parse(id));
			deleteWebhook(this.#db, shortId.parse(id));
			if (before) this.#audit(member, "webhook.deleted", webhookTarget(before), Date.now());
			return null;
		});
	}

	rotateWebhookSecret(member: MemberProfile, id: string): WebhookResult<string> {
		return this.#manage(member, () => {
			const now = Date.now();
			const secret = rotateSecret(this.#db, shortId.parse(id), now);
			const webhook = findWebhookRow(this.#db, shortId.parse(id));
			if (webhook) this.#audit(member, "webhook.secretRotated", webhookTarget(webhook), now);
			return secret;
		});
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
			() => {
				const now = Date.now();
				const created = createGitHubConnection(this.#db, member.id, now);
				const row = findGitHubRow(this.#db, created.connection.id);
				if (row) this.#audit(member, "github.connected", githubTarget(row), now, { app: false });
				return created;
			},
			"GitHub connections",
		);
	}

	/**
	 * Connects an installation of the deployment's GitHub App. The gateway has checked, with
	 * GitHub, that the member can reach the installation; only an admin may connect one.
	 */
	connectGitHubApp(
		member: MemberProfile,
		installation: { id: string; account: string | null },
	): WebhookResult<GitHubConnection> {
		const { id, account } = githubInstallation.parse(installation);
		return this.#manage(
			member,
			() => {
				const now = Date.now();
				// Connecting one that is already connected keeps it, and is no news.
				const known = this.#db
					.select({ id: schema.githubConnections.id })
					.from(schema.githubConnections)
					.where(eq(schema.githubConnections.installationId, id))
					.get();
				const connection = connectGitHubApp(this.#db, { id, account }, member.id, now);
				const row = known ? undefined : findGitHubRow(this.#db, connection.id);
				if (row) this.#audit(member, "github.connected", githubTarget(row), now, { app: true });
				return connection;
			},
			"GitHub connections",
		);
	}

	rotateGitHubSecret(member: MemberProfile, id: string): WebhookResult<string> {
		return this.#manage(
			member,
			() => {
				const secret = rotateGitHubSecret(this.#db, shortId.parse(id));
				const row = findGitHubRow(this.#db, shortId.parse(id));
				if (row) this.#audit(member, "github.secretRotated", githubTarget(row), Date.now());
				return secret;
			},
			"GitHub connections",
		);
	}

	deleteGitHubConnection(member: MemberProfile, id: string): WebhookResult<null> {
		return this.#manage(
			member,
			() => {
				const row = findGitHubRow(this.#db, shortId.parse(id));
				deleteGitHubConnection(this.#db, shortId.parse(id));
				if (row) this.#audit(member, "github.disconnected", githubTarget(row), Date.now());
				return null;
			},
			"GitHub connections",
		);
	}

	// RPC for the audit log (audit.ts). The workspace records most events itself; the gateway
	// reports the changes made in the app's database: people, invitations, agents, the workspace.

	/** Keeps an event the gateway reports, after its change was made. False for an invalid one. */
	audit(event: unknown): boolean {
		const parsed = gatewayAuditEvent.safeParse(event);
		if (!parsed.success) return false;
		this.ctx.storage.transactionSync(() => recordAudit(this.#db, parsed.data, Date.now()));
		return true;
	}

	/** A page of the audit log, the newest first, for admins. Nothing is written. */
	auditLog(member: MemberProfile, input: unknown): WebhookResult<AuditPage> {
		const request = auditPageRequest.safeParse(input);
		if (!request.success) return { ok: false, reason: "invalid", message: "Invalid page" };
		const row = activeMember(this.#db, memberProfile.parse(member).id);
		if (!row || !isAdminRole(row.role)) {
			return {
				ok: false,
				reason: "forbidden",
				message: "Only workspace admins can read the audit log",
			};
		}
		return { ok: true, value: readAuditPage(this.#db, request.data.before) };
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

	/**
	 * Pushes a member's news to the devices they asked for it on, as it happens. Track's app sends
	 * Web Push; without an app that does, nothing is sent. Called by the alarm, outside any
	 * transaction, at most once per notice.
	 */
	protected async sendPush(_notice: PushNotice): Promise<void> {}

	/**
	 * Emails whoever filed a request through a form or by email the decision on it. Does nothing
	 * here; the app's Worker overrides it, as it does `sendInboxDigest`.
	 */
	protected async sendRequesterNotice(_notice: RequesterNotice): Promise<void> {}

	/**
	 * The secret that signs the deployment's GitHub App's deliveries, or null where there is no
	 * app. None here; the app's Worker overrides it with its setting.
	 */
	protected githubAppSecret(): string | null {
		return null;
	}

	/** A delivery from a GitHub connection's webhook. */
	async github(input: unknown): Promise<GitHubDeliveryResult> {
		const parsed = githubDelivery.safeParse(input);
		if (!parsed.success) return { status: 400 };
		const delivery = parsed.data;
		const verified = await verifyGitHubDelivery(this.#db, delivery, this.githubAppSecret());
		if (verified === null) return { status: 404 };
		if (!verified) return { status: 401 };
		this.#write(() => applyGitHubDelivery(this.#db, delivery, Date.now()));
		return { status: 202 };
	}

	// Requests from people who need not be members, through a team's public form or its intake
	// email address. The gateway has checked the workspace exists and who may send them; the
	// channel's key is what admits them.

	/** The team a request form's key opens, or null for a form that is off or never was. */
	intakeForm(key: string): IntakeTarget | null {
		return findIntake(this.#db, "form", z.string().max(64).parse(key));
	}

	/** The team an intake email key reaches, or null for an address that is off or never was. */
	intakeEmail(key: string): IntakeTarget | null {
		return findIntake(this.#db, "email", z.string().max(64).parse(key));
	}

	/** Files a request through a team's channel. False when it is off, or the request invalid. */
	fileRequest(input: unknown): boolean {
		const parsed = intakeRequest.safeParse(input);
		if (!parsed.success) return false;
		const request = parsed.data;
		let filed = false;
		this.#write(() => {
			const outcome = fileRequest(this.#db, request, Date.now());
			filed = outcome !== null;
			return outcome?.result ?? { version: currentVersion(this.#db), ops: [] };
		});
		return filed;
	}

	/**
	 * Where a reply to `key` would be filed: the address the decision on its request went to, the
	 * only sender whose replies it takes, or null for a key no request has or a deleted request. The
	 * email gateway asks with the key alone before it reads the message, so mail to a made-up
	 * address costs no parsing, and compares the sender once it has. Writes nothing.
	 */
	replyTarget(key: string): { email: string } | null {
		const parsed = z.string().max(64).safeParse(key);
		const request = parsed.success ? findReplyRequest(this.#db, parsed.data) : null;
		return request && { email: request.email };
	}

	/**
	 * Files a requester's reply to the decision on their request as a comment on it. False for a
	 * key no request has, another sender, a deleted request, or a reply that is invalid.
	 */
	fileReply(input: unknown): boolean {
		const parsed = requesterReply.safeParse(input);
		if (!parsed.success) return false;
		const reply = parsed.data;
		let filed = false;
		this.#write(() => {
			const outcome = fileReply(this.#db, reply, Date.now());
			filed = outcome !== null;
			return outcome ?? { version: currentVersion(this.#db), ops: [] };
		});
		return filed;
	}

	/** Follows a change of the workspace's slug, so webhook payloads link to the right place. */
	relink(slug: string): void {
		this.ctx.storage.transactionSync(() => renameLink(this.#db, z.string().min(1).parse(slug)));
	}

	/**
	 * Reads for a backup of the workspace (backup.ts): the dump's statements run together and are
	 * rolled back. Called by the app's backup entrypoint, which only a Worker bound to it reaches.
	 */
	backupRead(statements: string[]): BackupRow[][] {
		return readForBackup(this.ctx.storage, statements);
	}

	// RPC for moving the workspace to another object (move.ts), which the app worker does from its
	// daily run when the deployment keeps workspaces in a jurisdiction. Nothing else calls these.

	/**
	 * Freezes the workspace for a move to `to` and says what it holds, or that it moved before. Its
	 * sockets close, and clients reconnect, to wherever the app sends them by then.
	 */
	async moveOut(token: string, to: string): Promise<MoveOut> {
		const out = freezeForMove(this.ctx.storage, this.#db, token, to, Date.now());
		if (!out.frozen) return out;
		this.#move = "frozen";
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1012, "Workspace moving");
			} catch {
				// Already closing.
			}
		}
		// The alarm's work waits for the move. If the move dies, the alarm ends the freeze.
		const until = freezeEnds(this.ctx.storage);
		if (until !== null) await this.ctx.storage.setAlarm(until);
		return out;
	}

	/** The next page of the frozen workspace's rows, about `chars` of them at most. */
	moveRead(token: string, cursor: MoveCursor, chars?: number): MovePage {
		return readForMove(this.ctx.storage, token, cursor, Date.now(), chars);
	}

	/** Seals the workspace once its copy is checked: it refuses everything from then on. */
	async moveSeal(token: string): Promise<void> {
		sealForMove(this.ctx.storage, token, Date.now());
		this.#move = "sealed";
		await this.ctx.storage.deleteAlarm();
	}

	/** Ends the freeze of a move that gave up, so the workspace works where it is. */
	moveThaw(token: string): Thawed {
		const thawed = thawAfterMove(this.ctx.storage, token);
		if (thawed === "thawed") {
			this.#move = null;
			this.#alarmSoon();
		}
		return thawed;
	}

	/** Empties this object, if it holds no live workspace, to take the rows of a move. */
	async moveIn(token: string, manifest: MoveManifest): Promise<void> {
		if (!mayImport(this.ctx.storage, this.#db)) {
			throw new Error("This object holds a workspace, so it can't take another's rows.");
		}
		await this.ctx.storage.deleteAll();
		await migrate(this.#db, migrations);
		beginImport(this.ctx.storage, token, manifest);
		this.#move = "importing";
	}

	/** Writes a page of the moving workspace's rows. */
	moveWrite(token: string, page: MoveRows[]): void {
		writeForMove(this.ctx.storage, token, page);
	}

	/** Checks the copied rows against what the workspace held. */
	moveCheck(token: string, manifest: MoveManifest): void {
		checkCopy(this.ctx.storage, this.#db, token, manifest);
	}

	/** A hash of each table's rows, for the two ends of a move to compare. */
	moveDigest(): Promise<Record<string, string>> {
		return digestTables(this.ctx.storage);
	}

	/** Ends a move into this object, which holds the workspace from now on, and runs its alarm. */
	async moveStart(version: number): Promise<void> {
		endImport(this.ctx.storage, this.#db, version);
		this.#move = null;
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** Permanently deletes the workspace's data. Called after the workspace itself is deleted. */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.Forbidden, "Workspace deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.#move = null;
	}

	// WebSocket lifecycle

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/socket" || request.headers.get("Upgrade") !== "websocket") {
			return new Response("Not found", { status: 404 });
		}
		// The client tries again shortly, by when the app sends it to where the workspace is.
		if (this.#away()) return new Response(MOVING_MESSAGE, { status: 503 });
		const userId = request.headers.get(MEMBER_HEADER);
		if (!userId || !activeMember(this.#db, userId)) {
			return new Response("Missing member", { status: 400 });
		}
		const session = socketSession.safeParse(parseJson(request.headers.get(SESSION_HEADER)));
		if (!session.success) return new Response("Missing session", { status: 400 });

		const link = workspaceLink.safeParse(parseJson(request.headers.get(LINK_HEADER)));
		if (link.success) this.ctx.storage.transactionSync(() => saveLink(this.#db, link.data));

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			userId,
			sessionId: session.data.id,
			expiresAt: session.data.expiresAt,
			clientId: null,
			live: false,
			through: 0,
		} satisfies SocketState);
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		if (closeIfExpired(ws, socketState(ws))) return;
		if (this.#away()) {
			ws.close(1012, "Workspace moving");
			return;
		}
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
	 * Moves teams' cycles on at their boundaries, reminds assignees of issues due today, runs teams'
	 * automations, makes the issues of templates on a schedule, compacts the log when that is due,
	 * and sends the pushes, webhook deliveries and inbox digests that are.
	 */
	override async alarm(): Promise<void> {
		if (this.#move === "sealed" || this.#move === "importing") return;
		if (this.#move === "frozen") {
			// A move under way: its work waits. One that died lets the freeze lapse, and work resumes.
			const until = freezeEnds(this.ctx.storage);
			if (until !== null && until > Date.now()) {
				await this.ctx.storage.setAlarm(until);
				return;
			}
			thaw(this.ctx.storage);
			this.#move = null;
		}
		const now = Date.now();
		// Deliveries this queues go out below, in this same run.
		this.#broadcast(this.ctx.storage.transactionSync(() => advanceCycles(this.#db, now)));
		this.#broadcast(this.ctx.storage.transactionSync(() => remindDue(this.#db, now)));
		this.#broadcast(this.ctx.storage.transactionSync(() => runAutomations(this.#db, now)));
		this.#broadcast(this.ctx.storage.transactionSync(() => runRecurring(this.#db, now)));
		if (now >= this.#compactionDue()) {
			this.ctx.storage.transactionSync(() => {
				compact(this.#db, now, RETENTION);
				pruneDeliveries(this.#db, now);
				pruneAudit(this.#db, now);
				const value = String(now + COMPACTION_INTERVAL_MS);
				this.#db
					.insert(schema.meta)
					.values({ key: COMPACTION_DUE_KEY, value })
					.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
					.run();
			});
		}
		// First, as news is pushed as it happens: the reminders above included.
		const pushes = this.ctx.storage.transactionSync(() => takeDuePushes(this.#db, Date.now()));
		await Promise.all(
			pushes.map((notice) =>
				this.sendPush(notice).catch((error) => {
					console.error("push: inbox news not pushed", error);
				}),
			),
		);
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
		if (hasRequesterNotices(this.#db)) {
			const notices = this.ctx.storage.transactionSync(() => takeRequesterNotices(this.#db));
			await Promise.all(
				notices.map((notice) =>
					this.sendRequesterNotice(notice).catch((error) => {
						console.error("email: decision on a request not sent", error);
					}),
				),
			);
		}
		// Cycles were just moved on, reminders sent, automations run and scheduled issues made, so one
		// that is still due is a clock disagreement, or more than a batch: look again in a minute.
		const soon = (at: number | null) =>
			at === null ? Number.POSITIVE_INFINITY : Math.max(at, Date.now() + 60_000);
		const next = more
			? Date.now()
			: Math.min(
					this.#compactionDue(),
					nextDeliveryAt(this.#db) ?? Number.POSITIVE_INFINITY,
					nextDigestAt(this.#db) ?? Number.POSITIVE_INFINITY,
					nextPushAt(this.#db) ?? Number.POSITIVE_INFINITY,
					soon(nextCycleChange(this.#db, Date.now())),
					soon(nextReminderAt(this.#db, Date.now())),
					soon(nextAutomationsAt(this.#db)),
					soon(nextRecurringAt(this.#db)),
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

	/** Runs a member's read. Anyone who is not an active member here is refused; nothing is written. */
	#read<T>(member: MemberProfile, fn: () => WebhookResult<T>): WebhookResult<T> {
		const profile = memberProfile.parse(member);
		if (!activeMember(this.#db, profile.id)) {
			return { ok: false, reason: "forbidden", message: "Not a workspace member" };
		}
		return fn();
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

	/** Records an admin's change to the workspace's integrations, inside its transaction. */
	#audit(
		member: MemberProfile,
		action: AuditAction,
		target: AuditTarget,
		now: number,
		detail?: AuditDetail,
	): void {
		recordAudit(this.#db, { actorId: member.id, action, target, ...(detail && { detail }) }, now);
	}

	/**
	 * Whether the workspace is moving out or has moved, so sockets get nowhere here. A freeze that
	 * has lapsed ends here, if the alarm hasn't ended it yet.
	 */
	#away(): boolean {
		if (this.#move === "sealed") return true;
		if (this.#move !== "frozen") return false;
		const until = freezeEnds(this.ctx.storage);
		if (until !== null && until > Date.now()) return true;
		thaw(this.ctx.storage);
		this.#move = null;
		this.#alarmSoon();
		return false;
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
			if (!state.live || closeIfExpired(ws, state)) continue;
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

/**
 * Closes a socket whose session has run out, so it neither sends nor hears anything more. The
 * client then asks the gateway whether its cookie still works: a session Better Auth has extended
 * since reconnects, and one that has ended signs in again.
 */
function closeIfExpired(ws: WebSocket, state: SocketState): boolean {
	if (state.expiresAt > Date.now()) return false;
	try {
		ws.close(CloseCode.SessionEnded, "Session expired");
	} catch {
		// Already closing.
	}
	return true;
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
