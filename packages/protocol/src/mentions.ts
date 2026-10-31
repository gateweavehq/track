/**
 * Mentions in descriptions and comments. A mention is a Markdown link to a member,
 * `[@Maya Chen](mention:<member id>)`: the text is their name when it was written, for whoever
 * reads the Markdown as it is, and the link names the member, so the app can show their current
 * name and renaming them breaks nothing. Writing a mention tells the member, once (the server's
 * `inbox.ts`). Mentions inside code are only text.
 */

export const MENTION_SCHEME = "mention:";

// The text may hold escaped brackets; ids are the ones members have, at most 64 characters.
const MENTION = /\[((?:\\.|[^\]\\\n])*)\]\(mention:([^\s()]{1,64})\)/g;
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/** The Markdown that mentions a member. */
export function mentionLink(member: { id: string; name: string }): string {
	const name = member.name.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ");
	return `[@${name}](${MENTION_SCHEME}${member.id})`;
}

/** The member a link mentions, or null for any other link. */
export function mentionedId(href: string | null | undefined): string | null {
	if (!href?.startsWith(MENTION_SCHEME)) return null;
	const id = href.slice(MENTION_SCHEME.length);
	return id.length > 0 && id.length <= 64 && !/[\s()]/.test(id) ? id : null;
}

/** The members a text mentions, each once, in the order they first appear. */
export function mentionedIds(markdown: string | null): string[] {
	if (!markdown?.includes(MENTION_SCHEME)) return [];
	const text = markdown.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
	return [...new Set(Array.from(text.matchAll(MENTION), (match) => match[2] ?? ""))];
}

/** The members `after` mentions that `before` did not: whom an edit newly mentions. */
export function newMentions(before: string | null, after: string | null): string[] {
	const known = new Set(mentionedIds(before));
	return mentionedIds(after).filter((id) => !known.has(id));
}

/**
 * The text with each mention as `@Name`, for where Markdown shows as plain text, such as an
 * email. `name` gives a member's current name; without one, the name as written stays.
 */
export function mentionsAsText(
	markdown: string,
	name: (id: string) => string | undefined = () => undefined,
): string {
	return markdown.replace(MENTION, (_, text: string, id: string) => {
		const current = name(id);
		return current === undefined ? text.replace(/\\(.)/g, "$1") : `@${current}`;
	});
}
