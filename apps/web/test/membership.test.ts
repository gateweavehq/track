import { CloseCode, PING, PONG } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

// Leaving a workspace (TRK-66): Better Auth deletes the member row without the hook that removing
// a member calls, and the workspace's Durable Object must still hear of it, so the person's open
// sockets close and the replica stops showing them as a member.

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
	return { id: user.id, cookie };
}

/** Makes someone a member without the invitation flow, which other tests cover. */
async function addMember(organizationId: string, userId: string) {
	await track.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
		)
		.bind(crypto.randomUUID(), organizationId, userId, Date.now())
		.run();
}

/** Opens a sync socket as a signed-in browser would, and notes how it closes. */
async function openSocket(slug: string, cookie: string) {
	const { status, ws } = await track.socket(`${origin}/api/sync/${slug}/socket`, {
		origin,
		cookie,
	});
	expect(status).toBe(101);
	if (!ws) throw new Error("No socket");
	const closed: { code?: number } = {};
	ws.addEventListener("close", (event) => {
		closed.code = event.code;
	});
	// A ping answered means the socket reaches the workspace's object.
	const pong = new Promise((resolve) => ws.addEventListener("message", resolve, { once: true }));
	ws.send(PING);
	expect(((await pong) as MessageEvent).data).toBe(PONG);
	return closed;
}

describe("leaving a workspace", () => {
	it("closes the person's sockets and removes them from the workspace's replica", async () => {
		const client = "203.0.113.120";
		const owner = await signUp(client, "Olu Owner", "olu@leave.test");
		const created = await authApi("/organization/create", {
			client,
			cookie: owner.cookie,
			body: { name: "Leavers", slug: "leavers" },
		});
		const { id: workspaceId } = (await created.json()) as { id: string };
		const lee = await signUp(client, "Lee Leaver", "lee@leave.test");
		await addMember(workspaceId, lee.id);

		const socket = await openSocket("leavers", lee.cookie);
		// The socket made Lee an active member of the replica.
		expect((await track.directory(workspaceId)).members).toContainEqual(
			expect.objectContaining({ id: lee.id, removedAt: null }),
		);

		const left = await authApi("/organization/leave", {
			client,
			cookie: lee.cookie,
			body: { organizationId: workspaceId },
		});
		expect(left.status).toBe(200);

		expect((await track.directory(workspaceId)).members).toContainEqual(
			expect.objectContaining({ id: lee.id, removedAt: expect.any(Number) }),
		);
		await vi.waitFor(() => expect(socket.code).toBe(CloseCode.Forbidden), { timeout: 5_000 });
		// The owner, who stayed, is untouched.
		expect((await track.directory(workspaceId)).members).toContainEqual(
			expect.objectContaining({ id: owner.id, removedAt: null }),
		);
	});

	it("tells the workspace nothing when leaving is refused", async () => {
		const client = "203.0.113.121";
		const sole = await signUp(client, "Sole Owner", "sole@leave.test");
		const created = await authApi("/organization/create", {
			client,
			cookie: sole.cookie,
			body: { name: "Solo", slug: "solo" },
		});
		const { id: workspaceId } = (await created.json()) as { id: string };
		const socket = await openSocket("solo", sole.cookie);

		// The only owner cannot leave.
		const left = await authApi("/organization/leave", {
			client,
			cookie: sole.cookie,
			body: { organizationId: workspaceId },
		});
		expect(left.status).toBe(400);
		expect(socket.code).toBeUndefined();
		expect((await track.directory(workspaceId)).members).toContainEqual(
			expect.objectContaining({ id: sole.id, removedAt: null }),
		);
	});
});
