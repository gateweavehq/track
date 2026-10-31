import { type NotificationSettings, notificationSettingsPatch } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { WebhookOutcome } from "./webhooks";

export interface WorkspaceNotifications {
	settings: NotificationSettings;
	/**
	 * Whether news can reach the person's email: not on a server without email, nor before they
	 * verify their address.
	 */
	email: "off" | "unverified" | "on";
	address: string;
}

const slug = z.string().min(1);

// Settings live in the workspace's Durable Object, which takes the verified member from here.
async function access(workspace: string) {
	const { db, getAuth } = await import("#/server/auth");
	const { findMembership, workspaceStub } = await import("#/server/workspaces");
	const request = getRequest();
	const session = await getAuth().api.getSession({ headers: request.headers });
	const membership = session && (await findMembership(db, workspace, session.user.id));
	if (!session || !membership) return null;
	return {
		user: session.user,
		member: membership.profile,
		stub: workspaceStub(membership.workspaceId),
	};
}

/** The signed-in person's notification settings in a workspace. Null for non-members. */
export const getNotificationSettings = createServerFn({ method: "GET" })
	.validator(slug)
	.handler(async ({ data: workspace }): Promise<WorkspaceNotifications | null> => {
		const found = await access(workspace);
		if (!found) return null;
		const result = await found.stub.notificationSettings(found.member);
		if (!result.ok) return null;
		const { mailer } = await import("#/server/email");
		const { demoEnabled } = await import("#/server/demo/mode");
		return {
			settings: result.value,
			email: !mailer || demoEnabled() ? "off" : found.user.emailVerified ? "on" : "unverified",
			address: found.user.email,
		};
	});

export const updateNotificationSettings = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, patch: notificationSettingsPatch }))
	.handler(async ({ data }): Promise<WebhookOutcome<NotificationSettings>> => {
		const found = await access(data.workspace);
		if (!found) {
			return {
				ok: false,
				reason: "not_found",
				message: "You are no longer a member of this workspace",
			};
		}
		return found.stub.updateNotificationSettings(found.member, data.patch);
	});
