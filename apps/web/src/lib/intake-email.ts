import type { Email } from "postal-mime";

/** The longest description an emailed request keeps; the rest of the text is cut. */
export const MAX_EMAILED_TEXT = 20_000;

/** Where an intake email address leads: a workspace, by its id, and a team's secret key. */
export interface IntakeAddress {
	/** Lowercase, as mail systems may change the case of an address. */
	workspaceId: string;
	key: string;
}

const LOCAL_PART = /^([a-z0-9_-]{1,40})\.([a-z2-7]{16})$/;

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
	return { workspaceId: match[1], key: match[2] };
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
	const subject = (email.subject ?? "").replace(/\s+/g, " ").trim();
	const title = (subject || `Email from ${sender}`).slice(0, 512);
	let text = (email.text ?? (email.html ? textOfHtml(email.html) : "")).replace(/\r\n?/g, "\n");
	text = text.trim();
	if (text.length > MAX_EMAILED_TEXT) text = `${text.slice(0, MAX_EMAILED_TEXT)}…\n\n(Cut short.)`;
	const notes = [`Sent by email from <${sender}>.`];
	const left = email.attachments.length - kept.length;
	if (left > 0) {
		notes.push(left === 1 ? "1 attachment was left out." : `${left} attachments were left out.`);
	}
	const parts = [text, kept.join("\n\n"), notes.join(" ")].filter((part) => part.length > 0);
	return { title, description: parts.join("\n\n") };
}

/** The text of an HTML-only email, roughly: tags out, paragraphs kept, entities read. */
function textOfHtml(html: string): string {
	return html
		.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}
