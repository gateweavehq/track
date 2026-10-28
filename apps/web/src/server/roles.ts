import type { MemberRole, PersonRole } from "@gateweave/track-protocol";

/**
 * Better Auth stores roles as a comma-separated list; the highest one wins. Agents are only ever
 * given `agent`, by the agents plugin, since Better Auth refuses roles it does not define.
 */
export function toRole(role: string): MemberRole {
	const roles = role.split(",").map((r) => r.trim());
	if (roles.includes("owner")) return "owner";
	if (roles.includes("admin")) return "admin";
	if (roles.includes("agent")) return "agent";
	return "member";
}

/** A person's role. Only agents are ever given `agent`, so anything else reads as a member. */
export function toPersonRole(role: string): PersonRole {
	const highest = toRole(role);
	return highest === "agent" ? "member" : highest;
}
