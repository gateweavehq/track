import { z } from "zod";
import type {
	Activity,
	Comment,
	Entities,
	EntityName,
	Issue,
	Label,
	Member,
	Project,
	Proposal,
	Team,
} from "./domain";
import type { MutationInput } from "./mutations";

/** Bump on any breaking change to messages or entity shapes. */
export const PROTOCOL_VERSION = 8;

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
	/** Ops in ascending version order. Sent for catch-up after `hello` and live after every write. */
	| { type: "delta"; ops: Op[] }
	/** Catch-up is complete; the client is live at `version`. */
	| { type: "ready"; version: number }
	/** The mutation was applied at `version`. Its ops arrive in a `delta` before this message. */
	| { type: "ack"; id: string; version: number }
	/** The mutation was not applied. The client should drop it and roll back its optimistic effect. */
	| { type: "reject"; id: string; reason: RejectReason; message?: string }
	/** The client's state cannot be caught up incrementally; it must fetch a fresh snapshot. */
	| { type: "reset" };

/** Full workspace state, served over HTTP so it can be compressed and fetched in parallel. */
export interface Snapshot {
	version: number;
	teams: Team[];
	issues: Issue[];
	labels: Label[];
	projects: Project[];
	/** Comments, activity and open proposals of live issues only. */
	comments: Comment[];
	activities: Activity[];
	proposals: Proposal[];
	members: Member[];
}

/** Where each entity's rows live in a snapshot. */
export const SNAPSHOT_KEYS = {
	team: "teams",
	issue: "issues",
	label: "labels",
	project: "projects",
	comment: "comments",
	activity: "activities",
	proposal: "proposals",
	member: "members",
} as const satisfies { [E in EntityName]: Exclude<keyof Snapshot, "version"> };
