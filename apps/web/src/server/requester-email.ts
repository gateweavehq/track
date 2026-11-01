import type { RequesterNotice } from "@gateweave/track-sync-server";
import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { mailer } from "./email";
import { requestDecisionEmail } from "./email/templates";

/**
 * Emails whoever filed a request through a team's form or by email what the team decided, for
 * the workspace's Durable Object. Only when email is on, never from the public demo, and within
 * the cap on emails to any one address, which the mailer keeps.
 */
export async function emailRequester(notice: RequesterNotice): Promise<void> {
	if (!mailer || demoEnabled()) return;
	const workspace = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, notice.workspaceId))
		.get();
	if (!workspace) return;
	await mailer.send({
		to: notice.email,
		...requestDecisionEmail({
			workspace: workspace.name,
			team: notice.team,
			title: notice.request.title,
			accepted: notice.accepted,
			reply: notice.reply,
		}),
	});
}
