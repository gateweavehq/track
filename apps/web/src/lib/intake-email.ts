import { cleanText, cutText } from "@gateweave/track-protocol";
import type { Email } from "postal-mime";

/** The longest description an emailed request keeps; the rest of the text is cut. */
export const MAX_EMAILED_TEXT = 20_000;

/**
 * Where an intake email address leads: a workspace, by its id, and a secret key. A team's key
 * files a request into its intake; a request's longer key files a reply to the decision on it.
 */
export interface IntakeAddress {
	/** Lowercase, as mail systems may change the case of an address. */
	workspaceId: string;
	kind: "team" | "reply";
	key: string;
}

const LOCAL_PART = /^([a-z0-9_-]{1,40})\.([a-z2-7]{16}|[a-z2-7]{26})$/;

/**
 * A team's intake email address: the workspace's id, a dot and the team's key, at the domain
 * whose Email Routing sends everything to Track. Lowercase, so no mail system changes it.
 */
export function intakeAddress(workspaceId: string, key: string, domain: string): string {
	return `${workspaceId.toLowerCase()}.${key}@${domain.toLowerCase()}`;
}

/** Reads an address that email arrived at, or null for one at another domain or of another form. */
export function parseIntakeAddress(to: string, domain: string): IntakeAddress | null {
	const at = to.lastIndexOf("@");
	if (at < 0 || to.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null;
	const match = LOCAL_PART.exec(to.slice(0, at).toLowerCase());
	if (!match?.[1] || !match[2]) return null;
	return { workspaceId: match[1], kind: match[2].length === 16 ? "team" : "reply", key: match[2] };
}

/**
 * Whether a message was sent by a machine on its own, such as an out-of-office reply, a bounce
 * or a mailing list. Such mail files no request: a vacation reply to every person who wrote
 * would fill a team's intake.
 */
export function isAutomated(headers: Headers): boolean {
	const auto = headers.get("auto-submitted")?.trim().toLowerCase();
	if (auto && auto !== "no") return true;
	const precedence = headers.get("precedence")?.trim().toLowerCase();
	if (precedence && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true;
	return (
		headers.has("x-autoreply") ||
		headers.has("x-autorespond") ||
		headers.has("list-id") ||
		headers.has("list-unsubscribe")
	);
}

/**
 * A request from an email: its subject as the title, its text as the description, the links to
 * the attachments that were kept, and who sent it at the end, with a note of the attachments that
 * were not.
 */
export function requestFromEmail(
	email: Pick<Email, "subject" | "text" | "html" | "attachments">,
	sender: string,
	/** The Markdown links to the attachments kept, in the email's order. */
	kept: string[] = [],
): { title: string; description: string } {
	const subject = cleanText(email.subject ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const title = cutText(subject || `Email from ${cleanText(sender)}`, 512);
	let text = textOf(email).trim();
	if (text.length > MAX_EMAILED_TEXT) text = `${cutText(text, MAX_EMAILED_TEXT)}…\n\n(Cut short.)`;
	const notes = [`Sent by email from <${cleanText(sender)}>.`];
	const left = email.attachments.length - kept.length;
	if (left > 0) {
		notes.push(left === 1 ? "1 attachment was left out." : `${left} attachments were left out.`);
	}
	const parts = [text, kept.join("\n\n"), notes.join(" ")].filter((part) => part.length > 0);
	return { title, description: parts.join("\n\n") };
}

/**
 * The text of a reply, without what it quotes: the lines a mail client marks with `>`, and
 * everything from the line that introduces the quoted message ("On … wrote:", "-----Original
 * Message-----") on. Cut short past MAX_EMAILED_TEXT.
 */
export function replyFromEmail(email: Pick<Email, "text" | "html">): string {
	const text = textOf(email);
	const lines = text.split("\n");
	const kept: string[] = [];
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		// Some clients wrap the introduction onto a second line.
		const next = `${trimmed} ${lines[index + 1]?.trim() ?? ""}`;
		if (
			/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed) ||
			/^on\s.*\swrote:$/i.test(trimmed) ||
			(/^on\s/i.test(trimmed) && /\swrote:$/i.test(next))
		) {
			break;
		}
		if (trimmed.startsWith(">")) continue;
		kept.push(line);
	}
	let reply = kept.join("\n").trim();
	if (reply.length > MAX_EMAILED_TEXT)
		reply = `${cutText(reply, MAX_EMAILED_TEXT)}…\n\n(Cut short.)`;
	return reply;
}

/**
 * An email's text with Unix line ends, cleaned: mail from anyone may carry NUL characters, which
 * Track refuses, and the mail is filed without them rather than bounced (TRK-79).
 */
function textOf(email: Pick<Email, "text" | "html">): string {
	const text = email.text ?? (email.html ? textOfHtml(email.html) : "");
	return cleanText(text).replace(/\r\n?/g, "\n");
}

const ENTITIES = new Map([
	["nbsp", " "],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["#39", "'"],
	["amp", "&"],
]);

/**
 * The text of an HTML-only email, roughly: tags out, paragraphs kept, entities read. The result is
 * Markdown and plain text, never HTML, so a tag left in it shows as text.
 *
 * It goes through the mail once. This is a stranger's mail, of up to 10 MiB, and regular expressions
 * over the whole of it took quadratic time on runs of `<` or of spaces, enough to use up a Worker's
 * CPU limit.
 */
function textOfHtml(html: string): string {
	const parts: string[] = [];
	// An element with no end here has none further on either, so nothing looks for it twice.
	const endless = new Set<string>();
	// The text from `at` is not kept yet, and the next tag is looked for from `from`.
	let at = 0;
	let from = 0;
	for (;;) {
		const open = html.indexOf("<", from);
		if (open < 0) break;
		// As in a browser, "a < b", "1<2" and "<>" are no tags, so they don't swallow what follows.
		if (!/[a-z/!?]/i.test(html.charAt(open + 1))) {
			from = open + 1;
			continue;
		}
		const close = html.indexOf(">", open + 1);
		if (close < 0) break;
		parts.push(html.slice(at, open));
		at = close + 1;
		from = at;
		const tag = html.slice(open + 1, close);
		if (/^(?:br\s*\/?|\/(?:p|div|li|tr|h[1-6]))$/i.test(tag)) {
			parts.push("\n");
			continue;
		}
		const hidden = /^(script|style|head)(?=[\s/]|$)/i.exec(tag)?.[1]?.toLowerCase();
		if (hidden && !endless.has(hidden)) {
			const end = new RegExp(`</${hidden}>`, "gi");
			end.lastIndex = at;
			if (end.test(html)) {
				at = end.lastIndex;
				from = at;
			} else {
				endless.add(hidden);
			}
		}
	}
	parts.push(html.slice(at));
	return (
		parts
			.join("")
			.replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (entity, name) => ENTITIES.get(name) ?? entity)
			// A whole run at a time, so one with no line end after it is not gone over again from each space.
			.replace(/[ \t]+(\n?)/g, (run, lineEnd) => lineEnd || run)
			.replace(/\n{3,}/g, "\n\n")
	);
}
