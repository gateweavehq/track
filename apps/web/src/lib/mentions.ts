import { type Member, mentionLink } from "@gateweave/track-protocol";
import { normalize } from "./search";

/** The mention being typed before the caret: where its "@" is, and what follows it. */
export interface MentionQuery {
	start: number;
	query: string;
}

// An "@" that starts a word, then up to two words of a name or the start of an email address.
const TYPING = /(?:^|[\s([{"'])@([^\s@[\]()`]{0,32}(?: [^\s@[\]()`]{1,32})?)$/u;

/** The mention being typed just before `caret`, if any. */
export function mentionQuery(value: string, caret: number): MentionQuery | null {
	const match = TYPING.exec(value.slice(0, caret));
	if (!match) return null;
	const query = match[1] ?? "";
	return { start: caret - query.length - 1, query };
}

/**
 * The members a query finds: those with a word of their name, or their email address, starting
 * with each word of it, ignoring case and accents. People come before agents, each in the order
 * given.
 */
export function mentionCandidates<M extends Pick<Member, "name" | "email" | "role">>(
	members: readonly M[],
	query: string,
	limit = 6,
): M[] {
	const words = normalize(query).split(" ").filter(Boolean);
	const found = members.filter((member) => {
		const name = normalize(member.name).split(/\s+/);
		const email = normalize(member.email);
		return words.every(
			(word) => email.startsWith(word) || name.some((part) => part.startsWith(word)),
		);
	});
	const people = found.filter((member) => member.role !== "agent");
	const agents = found.filter((member) => member.role === "agent");
	return [...people, ...agents].slice(0, limit);
}

/**
 * Puts a mention of `member` in place of what was typed from `start` to `caret`, followed by a
 * space. Returns the new text and where the caret goes, after that space.
 */
export function insertMention(
	value: string,
	start: number,
	caret: number,
	member: Pick<Member, "id" | "name">,
): { value: string; caret: number } {
	const link = mentionLink(member);
	const after = value.slice(caret);
	const text = /^\s/.test(after) ? link : `${link} `;
	return { value: value.slice(0, start) + text + after, caret: start + link.length + 1 };
}
