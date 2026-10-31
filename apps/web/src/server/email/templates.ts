import type { InboxEvent, IssueStatus } from "@gateweave/track-protocol";
import type { Email } from "./mailer";

/** An email before it is addressed. */
export type Message = Omit<Email, "to">;

const PRODUCT = "Gateweave Track";
const DAY = 24 * 60 * 60 * 1000;

export function passwordResetEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Reset your ${PRODUCT} password`,
		heading: "Reset your password",
		body: [
			`Someone asked to reset the password of your ${PRODUCT} account. If it was you, choose a new password below. The link works for one hour, once.`,
			"Resetting it signs you out on every device.",
		],
		action: { label: "Choose a new password", url },
		footer: "If you did not ask for this, ignore this email. Your password stays as it is.",
	});
}

export function verificationEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Verify your email for ${PRODUCT}`,
		heading: "Verify your email",
		body: [
			`Confirm that this address is yours to finish setting up your ${PRODUCT} account. Workspaces you are invited to need it before you can join. The link works for 24 hours.`,
		],
		action: { label: "Verify email", url },
		footer: `If you did not create a ${PRODUCT} account, ignore this email.`,
	});
}

export function invitationEmail({
	inviter,
	workspace,
	url,
	expiresAt,
	now = Date.now(),
}: {
	inviter: { name: string; email: string };
	workspace: string;
	url: string;
	expiresAt: number;
	now?: number;
}): Message {
	// Names are typed by whoever sends the invitation, so they are kept short and on one line.
	const name = clip(inviter.name, 60);
	const space = clip(workspace, 60);
	const days = Math.max(1, Math.round((expiresAt - now) / DAY));
	return compose({
		subject: `${name} invited you to ${space} on ${PRODUCT}`,
		heading: `Join ${space}`,
		body: [
			`${name} (${inviter.email}) invited you to the ${space} workspace on ${PRODUCT}, an issue tracker.`,
		],
		action: { label: `Join ${space}`, url },
		footer: `The invitation works only for this email address and expires in ${days} ${days === 1 ? "day" : "days"}. If you were not expecting it, ignore this email.`,
	});
}

const STATUS_NAMES: Record<IssueStatus, string> = {
	backlog: "Backlog",
	todo: "Todo",
	in_progress: "In Progress",
	in_review: "In Review",
	done: "Done",
	canceled: "Canceled",
};

/** Unread news on one issue, as an inbox digest lists it. */
export interface DigestEntry {
	key: string;
	title: string;
	url: string;
	event: InboxEvent;
	/** Who caused the newest event. */
	actor: string;
	unread: number;
	/** A comment's text, as written. */
	comment: string | null;
}

/** News a person left unread in a workspace's inbox. */
export function inboxDigestEmail({
	workspace,
	items,
	inboxUrl,
	settingsUrl,
}: {
	workspace: string;
	items: DigestEntry[];
	inboxUrl: string;
	settingsUrl: string;
}): Message {
	// Titles, names and comments are typed by members, so they are kept short and on one line.
	const space = clip(workspace, 60);
	const [only] = items;
	const subject =
		items.length === 1 && only
			? summary(only, `${only.key}: ${clip(only.title, 80)}`)
			: `${items.length} updates in ${space}`;
	const sections = items.map((item) => {
		const title = `${item.key} ${clip(item.title, 120)}`;
		const line = summary(item, item.key) + (item.unread > 1 ? ` · ${item.unread} updates` : "");
		const quote = item.comment === null ? null : clip(item.comment, 280);
		const quoteHtml = quote
			? `\n<p style="margin:8px 0 0;padding-left:12px;border-left:3px solid #e5e5e5;color:#404040">${escapeHtml(quote)}</p>`
			: "";
		return {
			text: [title, line, ...(quote ? [`> ${quote}`] : []), item.url].join("\n"),
			html: `<div style="margin:0 0 16px;padding:12px 16px;border:1px solid #e5e5e5;border-radius:6px">
<p style="margin:0"><a href="${escapeHtml(item.url)}" style="color:#171717;font-weight:600;text-decoration:none">${escapeHtml(title)}</a></p>
<p style="margin:4px 0 0;font-size:13px;color:#525252">${escapeHtml(line)}</p>${quoteHtml}
</div>`,
		};
	});
	return compose({
		subject,
		heading: `Unread in ${space}`,
		body: [],
		sections,
		action: { label: "Open your inbox", url: inboxUrl },
		footer:
			"You get this because news waited unread in your inbox for 10 minutes. Choose what reaches your email in your",
		footerLink: { label: "notification settings", url: settingsUrl },
	});
}

function summary(item: DigestEntry, issue: string): string {
	const actor = clip(item.actor, 60);
	switch (item.event.type) {
		case "assigned":
			return `${actor} assigned you ${issue}`;
		case "unassigned":
			return `${actor} unassigned you from ${issue}`;
		case "comment":
			return `${actor} commented on ${issue}`;
		case "status":
			return `${actor} moved ${issue} to ${STATUS_NAMES[item.event.to]}`;
		case "proposal":
			return `${actor} proposed a change to ${issue}`;
	}
}

function compose({
	subject,
	heading,
	body,
	sections = [],
	action,
	footer,
	footerLink,
}: {
	subject: string;
	heading: string;
	body: string[];
	/** Blocks after the body, such as the issues of a digest. */
	sections?: { text: string; html: string }[];
	action: { label: string; url: string };
	footer: string;
	/** A link that ends the footer's sentence. */
	footerLink?: { label: string; url: string };
}): Message {
	const text = [
		...body,
		...sections.map((section) => section.text),
		`${action.label}: ${action.url}`,
		footerLink ? `${footer} ${footerLink.label}: ${footerLink.url}` : footer,
		`— ${PRODUCT}`,
	].join("\n\n");
	const paragraphs = [
		...body.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`),
		...sections.map((section) => section.html),
	].join("");
	const footerHtml = footerLink
		? `${escapeHtml(footer)} <a href="${escapeHtml(footerLink.url)}" style="color:#525252">${escapeHtml(footerLink.label)}</a>.`
		: escapeHtml(footer);
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;color:#525252">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#525252">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>
<p style="margin:24px 0 0;font-size:13px;color:#737373">${footerHtml}</p>
</div>
</body>
</html>`;
	return { subject: oneLine(subject), text, html };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
	const line = oneLine(value);
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
