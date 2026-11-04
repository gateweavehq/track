import { CloseCode, PING, PONG, PROTOCOL_VERSION } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

// Ended sessions (TRK-68): the gateway checks the session only when a socket opens, and the
// workspace's Durable Object keeps the socket for as long as it lasts. Signing out, revoking a
// session and its running out must each close the sockets opened with it, and no others.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

function authApi(path: string, init: { client: string; cookie?: string; body: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body),
	});
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

const PASSWORD = "a-long-test-password";

/** Signs up and makes a workspace, as its owner. */
async function owner(client: string, email: string, slug: string) {
	const signedUp = await authApi("/sign-up/email", {
		client,
		body: { name: "Sam Session", email, password: PASSWORD },
	});
	expect(signedUp.status).toBe(200);
	const cookie = cookieOf(signedUp);
	const created = await authApi("/organization/create", {
		client,
		cookie,
		body: { name: slug, slug },
	});
	expect(created.status).toBe(200);
	return cookie;
}

/** Signs in again, as on another device: a second session. */
async function signIn(client: string, email: string, rememberMe = true) {
	const response = await authApi("/sign-in/email", {
		client,
		body: { email, password: PASSWORD, rememberMe },
	});
	expect(response.status).toBe(200);
	return cookieOf(response);
}

/** Opens a sync socket as a signed-in browser would, and notes what it hears and how it closes. */
async function openSocket(slug: string, cookie: string, headers: Record<string, string> = {}) {
	const { status, ws } = await track.socket(`${origin}/api/sync/${slug}/socket`, {
		...headers,
		origin,
		cookie,
	});
	expect(status).toBe(101);
	if (!ws) throw new Error("No socket");
	const socket: { code?: number; messages: string[]; ws: typeof ws } = { messages: [], ws };
	ws.addEventListener("close", (event) => {
		socket.code = event.code;
	});
	ws.addEventListener("message", (event) => {
		socket.messages.push(String(event.data));
	});
	// A ping answered means the socket reaches the workspace's object.
	ws.send(PING);
	await vi.waitFor(() => expect(socket.messages).toContain(PONG));
	return socket;
}

function hello(socket: Awaited<ReturnType<typeof openSocket>>) {
	socket.ws.send(
		JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "tab-1", since: 0 }),
	);
}

/** Says hello and waits to be caught up: the object still serves the socket. */
async function expectServed(socket: Awaited<ReturnType<typeof openSocket>>) {
	hello(socket);
	await vi.waitFor(() =>
		expect(socket.messages.some((message) => message.includes('"ready"'))).toBe(true),
	);
	expect(socket.code).toBeUndefined();
}

describe("ended sessions", () => {
	it("closes the socket of a session that signs out", async () => {
		const client = "203.0.113.140";
		const cookie = await owner(client, "out@sessions.test", "signs-out");
		const socket = await openSocket("signs-out", cookie);

		const signedOut = await authApi("/sign-out", { client, cookie, body: {} });
		expect(signedOut.status).toBe(200);

		await vi.waitFor(() => expect(socket.code).toBe(CloseCode.SessionEnded), { timeout: 5_000 });
	});

	it("closes the sockets of revoked sessions, and keeps the current one's", async () => {
		const client = "203.0.113.141";
		const email = "revoke@sessions.test";
		const current = await owner(client, email, "revokes");
		const elsewhere = await signIn(client, email);
		const kept = await openSocket("revokes", current);
		const revoked = await openSocket("revokes", elsewhere);

		const response = await authApi("/revoke-other-sessions", {
			client,
			cookie: current,
			body: {},
		});
		expect(response.status).toBe(200);

		await vi.waitFor(() => expect(revoked.code).toBe(CloseCode.SessionEnded), {
			timeout: 5_000,
		});
		await expectServed(kept);
	});

	it("goes by the session the gateway checked, not one the browser names", async () => {
		const client = "203.0.113.143";
		const cookie = await owner(client, "forged@sessions.test", "forges");
		const socket = await openSocket("forges", cookie, {
			"x-track-session": JSON.stringify({ id: "forged", expiresAt: Number.MAX_SAFE_INTEGER }),
		});

		const signedOut = await authApi("/sign-out", { client, cookie, body: {} });
		expect(signedOut.status).toBe(200);

		await vi.waitFor(() => expect(socket.code).toBe(CloseCode.SessionEnded), { timeout: 5_000 });
	});

	it("closes every session's sockets, in every workspace, when the password is reset", async () => {
		const client = "203.0.113.144";
		const email = "reset@sessions.test";
		const first = await owner(client, email, "resets");
		const created = await authApi("/organization/create", {
			client,
			cookie: first,
			body: { name: "resets-too", slug: "resets-too" },
		});
		expect(created.status).toBe(200);
		const cookies = [first, await signIn(client, email), await signIn(client, email)];
		const sockets: Awaited<ReturnType<typeof openSocket>>[] = [];
		for (const cookie of cookies) {
			for (const slug of ["resets", "resets-too"]) sockets.push(await openSocket(slug, cookie));
		}

		const requested = await authApi("/request-password-reset", {
			client,
			body: { email, redirectTo: "/reset-password" },
		});
		expect(requested.status).toBe(200);
		const token = await vi.waitFor(
			async () => {
				const sent = (await track.emails()).find(
					(each) => each.to === email && each.subject.startsWith("Reset your"),
				);
				const link = /\/api\/auth\/reset-password\/([^?\s]+)/.exec(sent?.text ?? "")?.[1];
				if (!link) throw new Error("No reset email yet");
				return link;
			},
			{ timeout: 5_000 },
		);
		const reset = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "a-new-long-test-password" },
		});
		expect(reset.status).toBe(200);

		await vi.waitFor(
			() =>
				expect(sockets.map((socket) => socket.code)).toEqual(
					sockets.map(() => CloseCode.SessionEnded),
				),
			{ timeout: 5_000 },
		);
	});

	it("refuses the socket of a session that has run out", async () => {
		const client = "203.0.113.142";
		const email = "expiry@sessions.test";
		await owner(client, email, "expires");
		// A session that is not remembered is never extended, so it runs out when it says it will.
		const cookie = await signIn(client, email, false);
		const session = await track.fetch(`${origin}/api/auth/get-session`, {
			headers: { origin, "cf-connecting-ip": client, cookie },
		});
		const { session: current } = (await session.json()) as { session: { id: string } };
		const expiresAt = Date.now() + 2_000;
		await track.db
			.prepare("UPDATE session SET expires_at = ? WHERE id = ?")
			.bind(expiresAt, current.id)
			.run();
		const socket = await openSocket("expires", cookie);

		await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() + 100));
		hello(socket);

		await vi.waitFor(() => expect(socket.code).toBe(CloseCode.SessionEnded), { timeout: 5_000 });
		expect(socket.messages.some((message) => message.includes('"ready"'))).toBe(false);
	});
});

describe("the page", () => {
	it("shows who is signed in, but not their session's token", async () => {
		const email = "page-token@example.com";
		const cookie = await owner("198.51.100.200", email, "page-token");
		const signed = /session_token=([^;]+)/.exec(cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const response = await track.fetch(`${origin}/`, { headers: { cookie } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(email);
		expect(html).not.toContain(token);
	});
});
