import { z } from "zod";
import type {
	Activity,
	Comment,
	Cycle,
	Entities,
	EntityName,
	InboxItem,
	Issue,
	IssueRelation,
	IssueTemplate,
	Label,
	Member,
	Project,
	ProjectUpdate,
	Proposal,
	PullRequest,
	SavedView,
	Subscription,
	SyncedIssue,
	Team,
} from "./domain";
import type { MutationInput } from "./mutations";
import type { WorkflowStatus } from "./statuses";

/** Bump on any breaking change to messages or entity shapes. */
export const PROTOCOL_VERSION = 25;

/** Plain-text keepalive. The server answers `"pong"` without waking a hibernated Durable Object. */
export const PING = "ping";
export const PONG = "pong";

/** WebSocket close codes used by the sync server (4000-4999 is reserved for applications). */
export const CloseCode = {
	/** Client and server speak different protocol versions; the client should reload. */
	ProtocolMismatch: 4001,
	/** The user is no longer a member of the workspace. */
	Forbidden: 4003,
	/** The client sent a message that is not valid protocol. */
	InvalidMessage: 4400,
} as const;

// Client -> server

export const helloMessage = z.object({
	type: z.literal("hello"),
	protocol: z.number().int(),
	/** Stable id for this client instance (one per tab/device), used to order its own writes. */
	clientId: z.string().min(1).max(64),
	/** Highest workspace version the client has applied. 0 means "nothing yet". */
	since: z.number().int().nonnegative(),
});

/**
 * Envelope for a mutation. The mutation body is validated separately so an invalid body can be
 * rejected by id instead of tearing down the connection.
 */
export const mutateEnvelope = z.object({
	type: z.literal("mutate"),
	/** Client-generated, globally unique. Resending the same id is safe and returns the original result. */
	id: z.string().min(1).max(64),
	mutation: z.unknown(),
});

export const clientMessage = z.discriminatedUnion("type", [helloMessage, mutateEnvelope]);

export type HelloMessage = z.infer<typeof helloMessage>;
export type MutateMessage = { type: "mutate"; id: string; mutation: MutationInput };
export type ClientMessage = HelloMessage | MutateMessage;

// Server -> client

export type Op = {
	[E in EntityName]: { version: number; entity: E; id: string } & (
		| { op: "put"; data: Entities[E] }
		| { op: "delete" }
	);
}[EntityName];

export const REJECT_REASONS = ["invalid", "forbidden", "not_found", "conflict"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type ServerMessage =
	/**
	 * The versions `from` through `to`, both included, and the ops among them meant for this
	 * client, in ascending order: other members' private ops are left out, so a delta can hold
	 * fewer ops than versions, or none. Each delta on a socket starts where the one before ended.
	 * Sent for catch-up after `hello` and live after writes.
	 */
	| { type: "delta"; from: number; to: number; ops: Op[] }
	/** Catch-up is complete; the client is live at `version`. */
	| { type: "ready"; version: number }
	/** The mutation was applied at `version`. Its ops arrive in a `delta` before this message. */
	| { type: "ack"; id: string; version: number }
	/** The mutation was not applied. The client should drop it and roll back its optimistic effect. */
	| { type: "reject"; id: string; reason: RejectReason; message?: string }
	/** The client's state cannot be caught up incrementally; it must fetch a fresh snapshot. */
	| { type: "reset" };

/**
 * Full workspace state as one member sees it, served over HTTP so it can be compressed and
 * fetched in parallel.
 */
export interface Snapshot {
	version: number;
	teams: Team[];
	/** Every team's statuses, removed ones included, so history still names them. */
	statuses: WorkflowStatus[];
	/** Live issues, archived ones slimmed to `ARCHIVED_ISSUE_FIELDS`. */
	issues: SyncedIssue[];
	labels: Label[];
	projects: Project[];
	/** The updates of live projects. */
	projectUpdates: ProjectUpdate[];
	cycles: Cycle[];
	/** Comments, activity and open proposals of live issues that are not archived. */
	comments: Comment[];
	activities: Activity[];
	proposals: Proposal[];
	/** Relations between live issues. */
	relations: IssueRelation[];
	/** Every saved view, personal ones included. */
	views: SavedView[];
	/** Every team's issue templates. */
	templates: IssueTemplate[];
	members: Member[];
	/** The member's own subscriptions and inbox, of live issues; nobody else's. */
	subscriptions: Subscription[];
	inbox: InboxItem[];
	/** Pull requests linked to live issues that are not archived. */
	pullRequests: PullRequest[];
}

/** Where each entity's rows live in a snapshot. */
export const SNAPSHOT_KEYS = {
	team: "teams",
	status: "statuses",
	issue: "issues",
	label: "labels",
	project: "projects",
	projectUpdate: "projectUpdates",
	cycle: "cycles",
	comment: "comments",
	activity: "activities",
	proposal: "proposals",
	relation: "relations",
	view: "views",
	template: "templates",
	member: "members",
	subscription: "subscriptions",
	inbox: "inbox",
	pullRequest: "pullRequests",
} as const satisfies { [E in EntityName]: Exclude<keyof Snapshot, "version"> };

// Reads over HTTP, beside the snapshot. Replicas hold an archived issue slim; these bring the
// rest of it from the server when there is a connection, for a page or an export, and are never
// written into a replica. They are additions, so clients that do not ask for them are unaffected.

/** What `GET /api/sync/:slug/issues/:issueId` takes: one live issue's id. */
export const issueDetailsRequest = z.object({ issueId: z.string().min(1).max(64) });

/**
 * What `GET /api/sync/:slug/archive` takes: every team's archived issues, or one team's
 * (`?team=`).
 */
export const archivedIssuesRequest = z.object({ teamId: z.string().min(1).max(64).nullable() });

export type IssueDetailsRequest = z.infer<typeof issueDetailsRequest>;
export type ArchivedIssuesRequest = z.infer<typeof archivedIssuesRequest>;

/**
 * A live issue whole, as the server holds it, with its comments and history (oldest first), its
 * open proposals and the pull requests that mention it. For an archived issue's page.
 */
export interface IssueDetails {
	issue: Issue;
	comments: Comment[];
	activities: Activity[];
	proposals: Proposal[];
	pullRequests: PullRequest[];
}

/** Archived issues whole, by team and number, with their comments and history. For exports. */
export interface ArchivedIssues {
	issues: Issue[];
	comments: Comment[];
	activities: Activity[];
}
