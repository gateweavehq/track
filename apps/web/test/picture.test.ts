import { afterAll, beforeAll, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// A member's picture is fetched by the browser of everyone in their workspaces, so whoever chooses
// its address learns who is looking and from where. github-sign-in.test.ts has the picture that stays.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

it("takes no picture from an email sign-up", async () => {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.70", "content-type": "application/json" },
		body: JSON.stringify({
			name: "Pia",
			email: "pia@picture.test",
			password: "a-long-test-password",
			image: "https://elsewhere.test/pixel.png",
		}),
	});
	expect(response.status).toBe(200);
	const row = await track.db
		.prepare("SELECT image FROM user WHERE email = ?")
		.bind("pia@picture.test")
		.first<{ image: string | null }>();
	expect(row).toEqual({ image: null });
});
