import type { InboxDigest } from "@gateweave/track-sync-server";
import { and, eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { mailer } from "./email";
import { inboxDigestEmail } from "./email/templates";
import { unsubscribeToken } from "./unsubscribe";

/**
 * Emails a member the inbox news they left unread, for the workspace's Durable Object. D1 has the
 * last word on who they are: the email goes only to a verified address, of someone still in the
 * workspace, and never from the public demo.
 */
export async function emailInboxDigest(digest: InboxDigest): Promise<void> {
	if (!mailer || demoEnabled()) return;
	const recipient = await db
		.select({
			email: schema.user.email,
			verified: schema.user.emailVerified,
			workspace: schema.organization.name,
			slug: schema.organization.slug,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.where(
			and(
				eq(schema.member.organizationId, digest.workspace.id),
				eq(schema.member.userId, digest.member.id),
			),
		)
		.get();
	if (!recipient?.verified) return;

	const { origin } = digest.workspace;
	const base = `${origin}/${encodeURIComponent(recipient.slug)}`;
	const message = inboxDigestEmail({
		workspace: recipient.workspace,
		items: digest.items.map((item) => ({
			key: item.issue.key,
			title: item.issue.title,
			url: `${base}/issue/${item.issue.key}`,
			event: item.event,
			actor: item.actor,
			unread: item.unread,
			comment: item.comment,
		})),
		inboxUrl: `${base}/inbox`,
		settingsUrl: `${base}/settings/notifications`,
	});
	const unsubscribe = `${origin}/api/unsubscribe/${await unsubscribeToken(digest.workspace.id, digest.member.id)}`;
	// Email Service accepts these only with an HTTPS link, which a local server does not have.
	const headers = unsubscribe.startsWith("https:")
		? {
				"List-Unsubscribe": `<${unsubscribe}>`,
				"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			}
		: undefined;
	await mailer.send({ to: recipient.email, ...message, ...(headers && { headers }) });
}
