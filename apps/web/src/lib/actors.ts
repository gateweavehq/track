import { GITHUB_ACTOR_ID, type Member, SYSTEM_ACTOR_ID } from "@gateweave/track-protocol";

/** Who made a change: a member, or Track or GitHub acting on its own. */
export function actorName(id: string, members: ReadonlyMap<string, Pick<Member, "name">>): string {
	if (id === SYSTEM_ACTOR_ID) return "Track";
	if (id === GITHUB_ACTOR_ID) return "GitHub";
	return members.get(id)?.name ?? "Someone";
}
