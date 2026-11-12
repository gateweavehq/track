import { describe, expect, it } from "vitest";
import { auditEventOf, isAuditedPath } from "./audit";

describe("audit events from Better Auth's answers", () => {
	it("follows only the paths that change who belongs to a workspace, or the workspace", () => {
		expect(isAuditedPath("/organization/invite-member")).toBe(true);
		expect(isAuditedPath("/organization/update")).toBe(true);
		expect(isAuditedPath("/organization/list-invitations")).toBe(false);
		expect(isAuditedPath("/sign-in/email")).toBe(false);
		expect(isAuditedPath("toString")).toBe(false);
		expect(isAuditedPath(undefined)).toBe(false);
	});

	it("names whoever joined as the one who did it", () => {
		const answer = {
			invitation: { id: "inv-1", organizationId: "ws-1" },
			member: { id: "m-1", userId: "user-joe", organizationId: "ws-1", role: "member" },
		};
		expect(auditEventOf("/organization/accept-invitation", answer, "user-joe")).toEqual({
			workspaceId: "ws-1",
			event: {
				actorId: "user-joe",
				action: "member.joined",
				target: { type: "member", id: "user-joe", label: null },
				detail: { role: "member" },
			},
		});
	});

	it("keeps an invited address in lower case, and says when it went again", () => {
		const answer = { id: "inv-1", email: "Bo@Example.COM", role: "admin", organizationId: "ws-1" };
		expect(
			auditEventOf("/organization/invite-member", answer, "user-ola", {
				body: { email: "Bo@Example.COM", role: "admin", resend: true },
			})?.event,
		).toEqual({
			actorId: "user-ola",
			action: "invitation.created",
			target: { type: "invitation", id: "inv-1", label: "bo@example.com" },
			detail: { role: "admin", resent: true },
		});
	});

	it("records a role change with what it was, when that is known, and not a role kept", () => {
		const answer = { id: "m-1", userId: "user-mo", organizationId: "ws-1", role: "admin" };
		const path = "/organization/update-member-role";
		expect(auditEventOf(path, answer, "user-ola", { replaced: { role: "member" } })?.event).toEqual(
			{
				actorId: "user-ola",
				action: "member.roleChanged",
				target: { type: "member", id: "user-mo", label: null },
				detail: { from: "member", to: "admin" },
			},
		);
		expect(auditEventOf(path, answer, "user-ola")?.event.detail).toEqual({ to: "admin" });
		expect(auditEventOf(path, answer, "user-ola", { replaced: { role: "admin" } })).toBeNull();
	});

	it("records what a workspace was called and where it was, as it changes", () => {
		const answer = { id: "ws-1", name: "Acme", slug: "acme-inc" };
		const path = "/organization/update";
		expect(
			auditEventOf(path, answer, "user-ola", { replaced: { name: "Acme", slug: "acme" } })?.event,
		).toEqual({
			actorId: "user-ola",
			action: "workspace.updated",
			target: { type: "workspace", id: "ws-1", label: "Acme" },
			detail: { slug: "acme-inc", previousSlug: "acme" },
		});
		expect(
			auditEventOf(path, answer, "user-ola", { replaced: { name: "Acme", slug: "acme-inc" } }),
		).toBeNull();
	});

	it("records nothing for a path that answered with an error", () => {
		const refused = { message: "You are not allowed", code: "FORBIDDEN", status: 403 };
		expect(auditEventOf("/organization/remove-member", refused, "user-ola")).toBeNull();
		expect(auditEventOf("/organization/leave", null, "user-ola")).toBeNull();
	});
});
