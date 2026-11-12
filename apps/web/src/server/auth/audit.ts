import type { GatewayAuditEvent } from "@gateweave/track-protocol";
import { z } from "zod";

/**
 * Better Auth's changes to who belongs to a workspace, turned into events for its audit log
 * (`@gateweave/track-protocol`'s audit.ts). Its organization hooks are told whom a change was
 * done to, but not who did it, so the events are made in the after hook, from the session and
 * what the path answered. What a change replaced, a role or a name, is read before it is made.
 */

/** The paths whose changes the audit log records, and what each answers. */
const answers = {
	"/organization/invite-member": z.object({
		id: z.string(),
		email: z.string(),
		role: z.string(),
		organizationId: z.string(),
	}),
	"/organization/cancel-invitation": z.object({
		id: z.string(),
		email: z.string(),
		organizationId: z.string(),
	}),
	"/organization/accept-invitation": z.object({
		member: z.object({ userId: z.string(), organizationId: z.string(), role: z.string() }),
	}),
	"/organization/remove-member": z.object({
		member: z.object({ userId: z.string(), organizationId: z.string() }),
	}),
	"/organization/update-member-role": z.object({
		userId: z.string(),
		organizationId: z.string(),
		role: z.string(),
	}),
	"/organization/leave": z.object({ userId: z.string(), organizationId: z.string() }),
	"/organization/update": z.object({ id: z.string(), name: z.string(), slug: z.string() }),
};

type AuditedPath = keyof typeof answers;

export function isAuditedPath(path: string | undefined): path is AuditedPath {
	return path !== undefined && Object.hasOwn(answers, path);
}

/** What a change replaced, read before it was made. */
export interface Replaced {
	role?: string;
	name?: string;
	slug?: string;
}

export interface WorkspaceEvent {
	workspaceId: string;
	event: GatewayAuditEvent;
}

/**
 * The event for what an audited path did, from what it answered: null when it changed nothing,
 * as when it answered with an error.
 */
export function auditEventOf(
	path: AuditedPath,
	answer: unknown,
	actorId: string,
	{ body, replaced }: { body?: unknown; replaced?: Replaced | undefined } = {},
): WorkspaceEvent | null {
	const event = (
		workspaceId: string,
		action: GatewayAuditEvent["action"],
		target: GatewayAuditEvent["target"],
		detail: Record<string, string | boolean> = {},
	): WorkspaceEvent => ({ workspaceId, event: { actorId, action, target, detail } });

	switch (path) {
		case "/organization/invite-member": {
			const invitation = answers[path].safeParse(answer);
			if (!invitation.success) return null;
			const { id, email, role, organizationId } = invitation.data;
			const resent = z.object({ resend: z.literal(true) }).safeParse(body).success;
			return event(
				organizationId,
				"invitation.created",
				{ type: "invitation", id, label: email.toLowerCase() },
				{ role, ...(resent && { resent: true }) },
			);
		}
		case "/organization/cancel-invitation": {
			const invitation = answers[path].safeParse(answer);
			if (!invitation.success) return null;
			const { id, email, organizationId } = invitation.data;
			return event(organizationId, "invitation.canceled", {
				type: "invitation",
				id,
				label: email.toLowerCase(),
			});
		}
		case "/organization/accept-invitation": {
			const accepted = answers[path].safeParse(answer);
			if (!accepted.success) return null;
			const { userId, organizationId, role } = accepted.data.member;
			return event(organizationId, "member.joined", member(userId), { role });
		}
		case "/organization/remove-member": {
			const removed = answers[path].safeParse(answer);
			if (!removed.success) return null;
			const { userId, organizationId } = removed.data.member;
			return event(organizationId, "member.removed", member(userId));
		}
		case "/organization/update-member-role": {
			const updated = answers[path].safeParse(answer);
			if (!updated.success) return null;
			const { userId, organizationId, role } = updated.data;
			if (replaced?.role === role) return null;
			return event(organizationId, "member.roleChanged", member(userId), {
				...(replaced?.role && { from: replaced.role }),
				to: role,
			});
		}
		case "/organization/leave": {
			const left = answers[path].safeParse(answer);
			if (!left.success) return null;
			const { userId, organizationId } = left.data;
			return event(organizationId, "member.left", member(userId));
		}
		case "/organization/update": {
			const workspace = answers[path].safeParse(answer);
			if (!workspace.success) return null;
			const { id, name, slug } = workspace.data;
			const detail: Record<string, string> = {};
			if (replaced?.name !== name) {
				Object.assign(
					detail,
					{ name },
					replaced?.name !== undefined && { previousName: replaced.name },
				);
			}
			if (replaced?.slug !== slug) {
				Object.assign(
					detail,
					{ slug },
					replaced?.slug !== undefined && { previousSlug: replaced.slug },
				);
			}
			if (Object.keys(detail).length === 0) return null;
			return event(id, "workspace.updated", { type: "workspace", id, label: name }, detail);
		}
	}
}

function member(userId: string): GatewayAuditEvent["target"] {
	return { type: "member", id: userId, label: null };
}
