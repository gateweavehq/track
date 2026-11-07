import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// A session cookie may be a stolen one. Better Auth offers any session routes that the app has no
// use for, and some of them ask for less than the app's own pages do, so they stay closed.

const origin = "https://track.test";
const PASSWORD = "a-long-test-password";

let track: Awaited<ReturnType<typeof startTrack>>;
let cookie: string;

function authApi(method: "GET" | "POST", path: string, body?: object) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method,
		headers: {
			origin,
			"cf-connecting-ip": "203.0.113.90",
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		...(method === "POST" && { body: JSON.stringify(body ?? {}) }),
	});
}

beforeAll(async () => {
	track = await startTrack(origin);
	const response = await authApi("POST", "/sign-up/email", {
		name: "Cleo",
		email: "cleo@stolen.test",
		password: PASSWORD,
	});
	expect(response.status).toBe(200);
	cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
});

afterAll(async () => {
	await track?.dispose();
});

describe("what a session cookie alone reaches", () => {
	it.each([
		["POST", "/unlink-account", { accountId: "any" }],
		["POST", "/verify-password", { password: PASSWORD }],
		["POST", "/change-password", { currentPassword: PASSWORD, newPassword: "another-long-one" }],
		["POST", "/get-access-token", { accountId: "any" }],
		["POST", "/refresh-token", { accountId: "any" }],
		["GET", "/account-info?accountId=any", undefined],
		["GET", "/list-accounts", undefined],
		["GET", "/list-sessions", undefined],
		["POST", "/update-user", { name: "Someone else" }],
	] as const)("not %s %s", async (method, path, body) => {
		const response = await authApi(method, path, body);
		expect(response.status).toBe(404);
	});

	it("is still a good session, which is why those answers mean something", async () => {
		const response = await authApi("GET", "/get-session");
		const session = (await response.json()) as { user: { name: string } };
		expect(session.user.name).toBe("Cleo");
	});

	it("leaves the password as it was", async () => {
		const signIn = await track.fetch(`${origin}/api/auth/sign-in/email`, {
			method: "POST",
			headers: {
				origin,
				"cf-connecting-ip": "203.0.113.91",
				"content-type": "application/json",
			},
			body: JSON.stringify({ email: "cleo@stolen.test", password: PASSWORD }),
		});
		expect(signIn.status).toBe(200);
	});
});
