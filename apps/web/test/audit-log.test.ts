import type { AuditPage } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

// The audit log (TRK-127): Better Auth's changes to a workspace's people, invitations, agents and
// the workspace itself reach the workspace's log, with who made them, once they are made.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

function authApi(path: string, init: { client: string; cookie: string; body: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			cookie: init.cookie,
		},
		body: JSON.stringify(init.body),
	});
}

async function ok<T>(response: Promise<Response>): Promise<T> {
	const answer = await response;
	expect(answer.status, await answer.clone().text()).toBe(200);
	return (await answer.json()) as T;
}

async function signUp(client: string, name: string, email: string) {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

/** Makes someone a member without the invitation flow, which needs a verified address. */
async function addMember(organizationId: string, userId: string) {
	const id = crypto.randomUUID();
	await track.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(id, organizationId, userId, Date.now())
		.run();
	return id;
}

describe("the audit log", () => {
	it("records who changed the workspace's people, invitations and agents", async () => {
		const client = "203.0.113.140";
		const owner = await signUp(client, "Ola Owner", "ola@audit.test");
		const { id: workspaceId } = await ok<{ id: string }>(
			authApi("/organization/create", {
				client,
				cookie: owner.cookie,
				body: { name: "Audited", slug: "audited" },
			}),
		);
		const admin = { id: owner.id, name: owner.name, email: owner.email, image: null };
		const read = () =>
			track.rpc<{ ok: true; value: AuditPage }>(
				workspaceId,
				"auditLog",
				{
					...admin,
					role: "owner",
				},
				{},
			);

		const invitation = await ok<{ id: string }>(
			authApi("/organization/invite-member", {
				client,
				cookie: owner.cookie,
				body: { email: "Ivy@Audit.test", role: "admin", organizationId: workspaceId },
			}),
		);
		await ok(
			authApi("/organization/cancel-invitation", {
				client,
				cookie: owner.cookie,
				body: { invitationId: invitation.id },
			}),
		);

		const mo = await signUp(client, "Mo Member", "mo@audit.test");
		const moMember = await addMember(workspaceId, mo.id);
		await ok(
			authApi("/organization/update-member-role", {
				client,
				cookie: owner.cookie,
				body: { memberId: moMember, role: "admin", organizationId: workspaceId },
			}),
		);
		// Refused, as only owners make owners of others here: nothing is recorded.
		const refused = await authApi("/organization/update-member-role", {
			client,
			cookie: mo.cookie,
			body: { memberId: moMember, role: "owner", organizationId: workspaceId },
		});
		expect(refused.status).not.toBe(200);

		const lee = await signUp(client, "Lee Leaver", "lee@audit.test");
		await addMember(workspaceId, lee.id);
		// As an invitation accepted would, so the workspace knows them by name.
		await track.rpc(workspaceId, "syncMember", {
			id: lee.id,
			name: lee.name,
			email: lee.email,
			image: null,
			role: "member",
		});
		await ok(
			authApi("/organization/leave", {
				client,
				cookie: lee.cookie,
				body: { organizationId: workspaceId },
			}),
		);
		await ok(
			authApi("/organization/remove-member", {
				client,
				cookie: owner.cookie,
				body: { memberIdOrEmail: moMember, organizationId: workspaceId },
			}),
		);

		const { agent } = await ok<{ agent: { id: string; keys: { id: string }[] } }>(
			authApi("/agents/create", {
				client,
				cookie: owner.cookie,
				body: { organizationId: workspaceId, name: "Bot" },
			}),
		);
		await ok(
			authApi("/agents/update", {
				client,
				cookie: owner.cookie,
				body: { agentId: agent.id, name: "Triage bot" },
			}),
		);
		const { key } = await ok<{ key: { id: string } }>(
			authApi("/agents/create-key", { client, cookie: owner.cookie, body: { agentId: agent.id } }),
		);
		await ok(
			authApi("/agents/revoke-key", { client, cookie: owner.cookie, body: { keyId: key.id } }),
		);
		await ok(
			authApi("/agents/delete", { client, cookie: owner.cookie, body: { agentId: agent.id } }),
		);

		// Events go to the workspace after the response.
		const expected = [
			{ action: "invitation.created", actorId: owner.id, label: "ivy@audit.test" },
			{ action: "invitation.canceled", actorId: owner.id, label: "ivy@audit.test" },
			{ action: "member.roleChanged", actorId: owner.id, target: mo.id },
			{ action: "member.left", actorId: lee.id, target: lee.id },
			{ action: "member.removed", actorId: owner.id, target: mo.id },
			{ action: "agent.created", actorId: owner.id, target: agent.id },
			{ action: "agent.renamed", actorId: owner.id, target: agent.id },
			{ action: "agent.keyCreated", actorId: owner.id, target: agent.id },
			{ action: "agent.keyRevoked", actorId: owner.id, target: agent.id },
			{ action: "agent.deleted", actorId: owner.id, target: agent.id },
		];
		let page: AuditPage | undefined;
		await vi.waitFor(
			async () => {
				const answer = await read();
				expect(answer.ok).toBe(true);
				page = answer.value;
				expect(page.events).toHaveLength(expected.length);
			},
			{ timeout: 10_000 },
		);
		if (!page) throw new Error("No log");
		// Background work can land in any order; the log is read here by what each event says.
		const events = [...page.events].sort((a, b) => a.id - b.id);
		expect(
			events.map((event) => ({
				action: event.action,
				actorId: event.actorId,
				...(event.target.type === "invitation"
					? { label: event.target.label }
					: { target: event.target.id }),
			})),
		).toEqual(expect.arrayContaining(expected));
		expect(events.find((event) => event.action === "member.roleChanged")?.detail).toEqual({
			from: "member",
			to: "admin",
		});
		expect(events.find((event) => event.action === "invitation.created")?.detail).toEqual({
			role: "admin",
		});
		expect(events.find((event) => event.action === "agent.renamed")?.detail).toEqual({
			from: "Bot",
			to: "Triage bot",
		});
		// Named as the workspace knows them, the ones who left included.
		expect(page.people[lee.id]?.name).toBe("Lee Leaver");
		expect(page.people[agent.id]).toEqual({ name: "Triage bot", image: null, agent: true });
		// No secret of an agent's key is in it.
		expect(JSON.stringify(page)).not.toMatch(/gwt_/);
	});
});
