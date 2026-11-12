import { z } from "zod";
import { AGENT_CHANGE_KINDS } from "./domain";

/**
 * A workspace's audit log: who changed who belongs to it and how it is set up, and when. What
 * people write in issues and comments is not in it; an issue's history keeps that.
 *
 * Changes to people, invitations, agents and the workspace itself are made in the app's database,
 * whose gateway reports them to the workspace. The rest the workspace records itself, in the same
 * transaction as the change.
 */

/** Changes the app's gateway reports. */
export const GATEWAY_AUDIT_ACTIONS = [
	/** Renamed, or given another address: `name` and `previousName`, `slug` and `previousSlug`. */
	"workspace.updated",
	/** `role`, and `resent` when it went again. The target's label is the address invited. */
	"invitation.created",
	"invitation.canceled",
	/** Accepted an invitation, as `role`. The actor is the one who joined. */
	"member.joined",
	"member.removed",
	"member.left",
	/** `from` and `to`. `from` is missing where it could not be known. */
	"member.roleChanged",
	"agent.created",
	/** `from` and `to`. */
	"agent.renamed",
	"agent.deleted",
	"agent.keyCreated",
	"agent.keyRevoked",
] as const;

/** Changes the workspace records itself. */
export const WORKSPACE_AUDIT_ACTIONS = [
	/** `key`. */
	"team.created",
	/** One change each: see `TeamChange`. */
	"team.updated",
	/** `team`, the team's key. */
	"status.created",
	/** `team`, and `change`, `from` and `to` for its name or category. */
	"status.updated",
	/** `team`, and `moveTo`: the name of the status its issues moved to. */
	"status.deleted",
	"label.deleted",
	"project.deleted",
	/** The label is the issue's key; its title is not kept. */
	"issue.deleted",
	/** Someone else's comment: `author`, a member id. The label is the issue's key. */
	"comment.deleted",
	/** What the agent must propose rather than do: `from` and `to`, lists of change kinds. */
	"agent.updated",
	/** The label is the URL's host: a URL's path can be its secret. */
	"webhook.created",
	/** `change`: `url` (with `from` and `to` hosts), `active` (with `to`) or `events`. */
	"webhook.updated",
	"webhook.deleted",
	"webhook.secretRotated",
	/** `app`: whether it is an installation of the deployment's GitHub App. */
	"github.connected",
	"github.secretRotated",
	"github.disconnected",
] as const;

export const AUDIT_ACTIONS = [...GATEWAY_AUDIT_ACTIONS, ...WORKSPACE_AUDIT_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type GatewayAuditAction = (typeof GATEWAY_AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
	"workspace",
	"invitation",
	"member",
	"agent",
	"team",
	"status",
	"label",
	"project",
	"issue",
	"comment",
	"webhook",
	"github",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** What a `team.updated` event changed. */
export type TeamChange =
	| { change: "name" | "key"; from: string; to: string }
	| { change: "archiveAfterMonths" | "closeAfterMonths"; from: number | null; to: number | null }
	/** Turned on, set differently, or turned off. */
	| { change: "cycles"; to: "on" | "changed" | "off" }
	/** Turned on, given a new link or address, or turned off. */
	| { change: "intakeForm" | "intakeEmail"; to: "on" | "renewed" | "off" };

export type AuditValue = string | number | boolean | null | string[];
export type AuditDetail = Record<string, AuditValue>;

/** What an event was done to. A label is taken at the time, for things that may be gone later. */
export interface AuditTarget {
	type: AuditTargetType;
	id: string | null;
	label: string | null;
}

export interface AuditEvent {
	/** Grows with each event, so pages are cut by it. */
	id: number;
	at: number;
	/** The member who did it, or null for Track itself. */
	actorId: string | null;
	action: AuditAction;
	target: AuditTarget;
	detail: AuditDetail;
}

/** A member an event names, as the workspace knows them when the log is read. */
export interface AuditPerson {
	name: string;
	image: string | null;
	agent: boolean;
}

export interface AuditPage {
	events: AuditEvent[];
	/** Everyone the events name, by id: actors, members and agents acted on, comments' authors. */
	people: Record<string, AuditPerson>;
	/** Pass as `before` for the next page; null when there is none. */
	next: number | null;
}

export const AUDIT_PAGE_SIZE = 50;

export const auditPageRequest = z.object({ before: z.number().int().positive().optional() });
export type AuditPageRequest = z.input<typeof auditPageRequest>;

const auditValue = z.union([
	z.string().max(320),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.string().max(64)).max(AGENT_CHANGE_KINDS.length),
]);

/** An event the gateway reports, checked by the workspace before it is kept. */
export const gatewayAuditEvent = z.object({
	actorId: z.string().min(1).max(64).nullable(),
	action: z.enum(GATEWAY_AUDIT_ACTIONS),
	target: z.object({
		type: z.enum(AUDIT_TARGET_TYPES),
		id: z.string().min(1).max(64).nullable(),
		// An email address can be 254 characters.
		label: z.string().max(320).nullable(),
	}),
	detail: z
		.record(z.string().max(32), auditValue)
		.refine((detail) => Object.keys(detail).length <= 8, "Too much detail")
		.default({}),
});
export type GatewayAuditEvent = z.input<typeof gatewayAuditEvent>;
