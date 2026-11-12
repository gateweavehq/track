import type { AuditEvent, AuditPerson, AuditValue } from "@gateweave/track-protocol";

/**
 * Audit events in words: who did it, and what, as "Ada" and "invited bob@example.com as an
 * admin". People are named as the workspace knows them when the log is read.
 */

type People = Record<string, AuditPerson>;

/** Who did it: a member, Track itself, or someone the workspace no longer knows. */
export function auditActor(event: AuditEvent, people: People): string {
	if (event.actorId === null) return "Track";
	return people[event.actorId]?.name ?? "Someone";
}

/** What they did, to follow their name. */
export function auditSentence(event: AuditEvent, people: People): string {
	const { detail, target } = event;
	const label = target.label ?? "something since deleted";
	const person = (id: AuditValue | undefined) =>
		(typeof id === "string" && people[id]?.name) || "someone";
	const named = person(target.id);
	const text = (key: string) => {
		const value = detail[key];
		return typeof value === "string" ? value : "";
	};
	const team = text("team");

	switch (event.action) {
		case "workspace.updated": {
			const parts: string[] = [];
			if (detail.name !== undefined) {
				parts.push(
					detail.previousName === undefined
						? `renamed the workspace to ${text("name")}`
						: `renamed the workspace from ${text("previousName")} to ${text("name")}`,
				);
			}
			if (detail.slug !== undefined) parts.push(`moved the workspace to /${text("slug")}`);
			return parts.join(" and ") || "changed the workspace";
		}
		case "invitation.created": {
			const invited = target.label ?? "an address since forgotten";
			return detail.resent === true
				? `sent the invitation to ${invited} again`
				: `invited ${invited} as ${role(detail.role)}`;
		}
		case "invitation.canceled":
			return `revoked the invitation to ${target.label ?? "an address since forgotten"}`;
		case "member.joined":
			return `joined the workspace as ${role(detail.role)}`;
		case "member.removed":
			return `removed ${named} from the workspace`;
		case "member.left":
			return "left the workspace";
		case "member.roleChanged":
			return detail.from === undefined
				? `made ${named} ${role(detail.to)}`
				: `changed ${named}'s role from ${roleName(detail.from)} to ${roleName(detail.to)}`;
		case "agent.created":
			return `added the agent ${named === "someone" ? label : named}`;
		case "agent.renamed":
			return `renamed the agent ${text("from")} to ${text("to")}`;
		case "agent.deleted":
			return `deleted the agent ${label}`;
		case "agent.keyCreated":
			return `made a key for the agent ${named}`;
		case "agent.keyRevoked":
			return `revoked a key of the agent ${named}`;
		case "agent.updated": {
			const kinds = Array.isArray(detail.to) ? detail.to : [];
			return kinds.length === 0
				? `let the agent ${named} make every change itself`
				: `had the agent ${named} propose changes to ${list(kinds.map(changeKind))}`;
		}
		case "team.created":
			return `created the team ${label} (${text("key")})`;
		case "team.updated":
			return teamSentence(event, label);
		case "status.created":
			return `added the status ${label} to ${team}`;
		case "status.updated":
			return detail.change === "name"
				? `renamed the status ${text("from")} in ${team} to ${text("to")}`
				: `moved the status ${label} in ${team} from ${text("from")} to ${text("to")}`;
		case "status.deleted":
			return `removed the status ${label} from ${team}, moving its issues to ${text("moveTo")}`;
		case "label.deleted":
			return `deleted the label ${label}`;
		case "project.deleted":
			return `deleted the project ${label}`;
		case "issue.deleted":
			return `deleted ${label}`;
		case "comment.deleted":
			return `deleted a comment by ${person(detail.author)} on ${label}`;
		case "webhook.created":
			return `added a webhook to ${label}`;
		case "webhook.updated":
			if (detail.change === "url") {
				return detail.from === detail.to
					? `changed the address of the webhook to ${label}`
					: `moved a webhook from ${text("from")} to ${text("to")}`;
			}
			if (detail.change === "active") {
				return detail.to === true
					? `resumed the webhook to ${label}`
					: `paused the webhook to ${label}`;
			}
			return `changed what the webhook to ${label} is sent`;
		case "webhook.deleted":
			return `deleted the webhook to ${label}`;
		case "webhook.secretRotated":
			return `replaced the secret of the webhook to ${label}`;
		case "github.connected":
			return detail.app === true
				? `connected GitHub${target.label ? ` for ${target.label}` : ""}`
				: "added a GitHub webhook";
		case "github.secretRotated":
			return `replaced the secret of a GitHub webhook${target.label ? ` for ${target.label}` : ""}`;
		case "github.disconnected":
			return `disconnected GitHub${target.label ? ` for ${target.label}` : ""}`;
	}
}

function teamSentence({ detail }: AuditEvent, team: string): string {
	const to = detail.to;
	switch (detail.change) {
		case "name":
			return `renamed the team ${String(detail.from)} to ${String(to)}`;
		case "key":
			return `changed the key of ${team} from ${String(detail.from)} to ${String(to)}`;
		case "archiveAfterMonths":
			return typeof to === "number"
				? `had ${team} archive closed issues after ${months(to)}`
				: `stopped archiving ${team}'s closed issues`;
		case "closeAfterMonths":
			return typeof to === "number"
				? `had ${team} close issues left alone for ${months(to)}`
				: `stopped closing ${team}'s issues left alone`;
		case "cycles":
			return to === "on"
				? `turned on cycles for ${team}`
				: to === "off"
					? `turned off cycles for ${team}`
					: `changed ${team}'s cycles`;
		case "intakeForm":
			return to === "on"
				? `opened a public request form for ${team}`
				: to === "off"
					? `closed ${team}'s public request form`
					: `gave ${team}'s request form a new link`;
		case "intakeEmail":
			return to === "on"
				? `turned on an intake email address for ${team}`
				: to === "off"
					? `turned off ${team}'s intake email address`
					: `gave ${team} a new intake email address`;
		default:
			return `changed the team ${team}`;
	}
}

const ROLE_NAMES: Record<string, string> = {
	owner: "owner",
	admin: "admin",
	member: "member",
	agent: "agent",
};

function roleName(value: AuditValue | undefined): string {
	return (typeof value === "string" && ROLE_NAMES[value]) || "unknown role";
}

/** "an admin", "a member". */
function role(value: AuditValue | undefined): string {
	const name = roleName(value);
	return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
}

const CHANGE_KINDS: Record<string, string> = {
	title: "titles",
	description: "descriptions",
	status: "statuses",
	close: "closing",
	priority: "priorities",
	assignee: "assignees",
	labels: "labels",
	project: "projects",
};

function changeKind(kind: string): string {
	return CHANGE_KINDS[kind] ?? kind;
}

function list(items: string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function months(n: number): string {
	return n === 1 ? "a month" : `${n} months`;
}
