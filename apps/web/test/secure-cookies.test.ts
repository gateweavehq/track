import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// BETTER_AUTH_URL is optional, and without it Better Auth decides on `Secure` from NODE_ENV, which a
// Worker never has. A browser would then send the session cookie over plain HTTP, such as on the
// first request to a custom domain.

function signUp(track: Awaited<ReturnType<typeof startTrack>>, origin: string) {
	return track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({
			name: "Sam Secure",
			email: "sam@example.com",
			password: "a-long-test-password",
		}),
	});
}

describe("a deployment with no BETTER_AUTH_URL", () => {
	const origin = "https://track.test";
	let track: Awaited<ReturnType<typeof startTrack>>;

	beforeAll(async () => {
		track = await startTrack(origin, { vars: { BETTER_AUTH_URL: "" } });
	});
	afterAll(() => track.dispose());

	it("marks its cookies Secure and keeps their names, so nobody is signed out", async () => {
		const response = await signUp(track, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure/i);
	});
});

describe("the browser tests' build, pinned to localhost over plain HTTP", () => {
	const origin = "http://localhost:4711";
	let track: Awaited<ReturnType<typeof startTrack>>;

	beforeAll(async () => {
		track = await startTrack(origin);
	});
	afterAll(() => track.dispose());

	it("leaves Secure off, as Better Auth does for a plain HTTP address", async () => {
		const response = await signUp(track, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*Secure/i);
	});
});
