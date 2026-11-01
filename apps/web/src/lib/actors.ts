import {
	GITHUB_ACTOR_ID,
	INTAKE_EMAIL_ACTOR_ID,
	INTAKE_FORM_ACTOR_ID,
	type Member,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";

/** The name of what acts on its own: Track, GitHub, or a team's request form or email address. */
export function systemActorName(id: string): string | null {
	if (id === SYSTEM_ACTOR_ID) return "Track";
	if (id === GITHUB_ACTOR_ID) return "GitHub";
	if (id === INTAKE_FORM_ACTOR_ID) return "Request form";
	if (id === INTAKE_EMAIL_ACTOR_ID) return "Email";
	return null;
}

/** Who made a change: a member, or Track, GitHub, or a team's request form or email address acting on its own. */
export function actorName(id: string, members: ReadonlyMap<string, Pick<Member, "name">>): string {
	return systemActorName(id) ?? members.get(id)?.name ?? "Someone";
}
