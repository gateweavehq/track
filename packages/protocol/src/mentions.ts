/**
 * Mentions in descriptions and comments. A mention is a Markdown link to a member,
 * `[@Maya Chen](mention:<member id>)`: the text is their name when it was written, for whoever
 * reads the Markdown as it is, and the link names the member, so the app can show their current
 * name and renaming them breaks nothing. Writing a mention tells the member, once (the server's
 * `inbox.ts`). Mentions inside code are only text.
 *
 * All this reads what people write, up to 100,000 characters, some of it inside a workspace's
 * write transaction. So each step is one pass over the text: regular expressions that did it in one
 * go took over ten seconds on a text of nothing but brackets or backticks.
 */

export const MENTION_SCHEME = "mention:";

// What decides where a mention's text starts and ends: an escaped character, a line's end, a
// bracket. Ids are the ones members have, at most 64 characters.
const MENTION_PART = /\\.|\n|\[|\]\(mention:([^\s()]{1,64})\)|\]/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BACKTICKS = /`+/g;

interface Mention {
	start: number;
	end: number;
	/** The name as written, with its escapes. */
	text: string;
	id: string;
}

function mentionsIn(markdown: string): Mention[] {
	const mentions: Mention[] = [];
	let open: number | null = null;
	for (const part of markdown.matchAll(MENTION_PART)) {
		const [token, id] = part;
		if (token === "[") open = part.index;
		// Markdown takes this for a bracket and no link, but the name is there all the same.
		else if (token === "\\[") open ??= part.index + 1;
		else if (!token.startsWith("\\")) {
			if (id !== undefined && open !== null) {
				const end = part.index + token.length;
				mentions.push({ start: open, end, text: markdown.slice(open + 1, part.index), id });
			}
			open = null;
		}
	}
	return mentions;
}

function replaceMentions(markdown: string, replacement: (mention: Mention) => string): string {
	let replaced = "";
	let at = 0;
	for (const mention of mentionsIn(markdown)) {
		replaced += markdown.slice(at, mention.start) + replacement(mention);
		at = mention.end;
	}
	return replaced + markdown.slice(at);
}

/** The text without its fenced blocks. One that nothing closes runs to the end. */
function withoutFences(markdown: string): string {
	const kept: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const [marker = "", run] = FENCE.exec(line) ?? [];
		if (fence === null) {
			if (run) fence = run;
			else kept.push(line);
		} else if (run?.startsWith(fence) && line.slice(marker.length).trim() === "") {
			fence = null;
		}
	}
	return kept.join("\n");
}

/** The text without its inline code: from a run of backticks to the next run just as long. */
function withoutInlineCode(text: string): string {
	const runs = Array.from(text.matchAll(BACKTICKS), (run) => ({
		start: run.index,
		length: run[0].length,
		closesAt: null as number | null,
	}));
	const nextOfLength = new Map<number, number>();
	for (const run of [...runs].reverse()) {
		run.closesAt = nextOfLength.get(run.length) ?? null;
		nextOfLength.set(run.length, run.start + run.length);
	}
	let kept = "";
	let at = 0;
	for (const run of runs) {
		if (run.start < at || run.closesAt === null) continue;
		kept += text.slice(at, run.start);
		at = run.closesAt;
	}
	return kept + text.slice(at);
}

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
	const text = withoutInlineCode(withoutFences(markdown));
	return [...new Set(mentionsIn(text).map((mention) => mention.id))];
}

/** The members `after` mentions that `before` did not: whom an edit newly mentions. */
export function newMentions(before: string | null, after: string | null): string[] {
	const known = new Set(mentionedIds(before));
	return mentionedIds(after).filter((id) => !known.has(id));
}

/**
 * The text with its mentions of one member showing `name` instead of the name as written, inside
 * code too: code only stops a mention from telling anyone, and the name is there all the same.
 */
export function renameMentions(markdown: string, member: { id: string; name: string }): string {
	if (!markdown.includes(`${MENTION_SCHEME}${member.id})`)) return markdown;
	const link = mentionLink(member);
	return replaceMentions(markdown, ({ id, start, end }) =>
		id === member.id ? link : markdown.slice(start, end),
	);
}

/**
 * The text with each mention as `@Name`, for where Markdown shows as plain text, such as an
 * email. `name` gives a member's current name; without one, the name as written stays.
 */
export function mentionsAsText(
	markdown: string,
	name: (id: string) => string | undefined = () => undefined,
): string {
	return replaceMentions(markdown, ({ id, text }) => {
		const current = name(id);
		return current === undefined ? text.replace(/\\(.)/g, "$1") : `@${current}`;
	});
}
