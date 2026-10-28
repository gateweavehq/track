import { afterAll, beforeAll, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Better Auth began resolving its context when the Worker loaded, and the oauth-provider plugin
// queried D1 while doing so. workerd forbids I/O in global scope, so every cold start logged an
// error that hid real ones (TRK-22).

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

it("starts and serves requests without logging an error", async () => {
	// Reaches the page, the auth API and the OAuth discovery route, which all use Better Auth.
	await track.fetch(`${origin}/login`);
	await track.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
	const discovery = await track.fetch(`${origin}/.well-known/oauth-protected-resource`);
	expect(discovery.status).toBe(200);

	expect(track.logs.filter((log) => log.level === "error")).toEqual([]);
});
