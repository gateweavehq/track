import { type AuditPage, auditPageRequest } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export type { AuditEvent, AuditPage, AuditPerson } from "@gateweave/track-protocol";

export interface WorkspaceAudit {
	admin: boolean;
	page: AuditPage;
}

const none: AuditPage = { events: [], people: {}, next: null };

/**
 * A page of the workspace's audit log, the newest first, for admins. Null for non-members. The
 * workspace's Durable Object checks the role too, so a member who is no longer an admin is refused.
 */
export const getAuditLog = createServerFn({ method: "GET" })
	.validator(z.object({ workspace: z.string().min(1) }).extend(auditPageRequest.shape))
	.handler(async ({ data }): Promise<WorkspaceAudit | null> => {
		const { webhookAccess } = await import("#/server/webhooks");
		const found = await webhookAccess(data.workspace, getRequest());
		if (!found) return null;
		if (!found.admin) return { admin: false, page: none };
		const result = await found.stub.auditLog(found.member, { before: data.before });
		return result.ok ? { admin: true, page: result.value } : { admin: false, page: none };
	});
