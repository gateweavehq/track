import { afterAll, beforeAll, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Better Auth turns its limiter on only when NODE_ENV is "production", which a Worker never sets,
// so the deployed app took unlimited password guesses (TRK-23).

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

async function signIn(headers: Record<string, string>) {
	const response = await track.fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...headers },
		body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
	});
	return response.status;
}

it("limits sign-in attempts from one client", async () => {
	const client = { "cf-connecting-ip": "203.0.113.7" };
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signIn(client));
	expect(statuses).toEqual([401, 401, 401, 429]);

	expect(await signIn({ "cf-connecting-ip": "203.0.113.8" })).toBe(401);
});

it("tells clients apart by the address Cloudflare saw, not one they claim", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({
				"cf-connecting-ip": "198.51.100.20",
				"x-forwarded-for": `192.0.2.${attempt + 1}`,
			}),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});
