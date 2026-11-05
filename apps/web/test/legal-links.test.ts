import type { Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// The legal notice has to be easy to reach, and the policy has to be there when someone gives us
// their data (TRK-94). But they are one deployment's own: a copy someone else runs must show none
// unless it sets its own. These read the HTML the server sends.

const origin = "https://track.test";
const SIGN_IN_PAGES = [
	"/login",
	"/forgot-password",
	"/reset-password",
	"/invite/none",
	"/oauth/consent?client_id=none",
];

type Track = Awaited<ReturnType<typeof startTrack>>;

async function page(track: Track, path: string, status = 200) {
	const response = await track.fetch(`${origin}${path}`);
	expect(response.status).toBe(status);
	return response.text();
}

/** The address of a team's request form, turned on. */
async function aRequestForm(track: Track) {
	const signUp = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.91", "content-type": "application/json" },
		body: JSON.stringify({ name: "Ines", email: "ines@track.test", password: "a-long-password" }),
	});
	const { user } = (await signUp.json()) as { user: { id: string } };
	const cookie = signUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	});
	const workspaceId = ((await created.json()) as { id: string }).id;
	const owner = { id: user.id, name: "Ines", email: "ines@track.test", image: null, role: "owner" };
	await track.mutate(workspaceId, owner, {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
	await track.mutate(workspaceId, owner, {
		name: "team.update",
		args: { id: "team-eng", patch: { intakeForm: true } },
	});
	const snapshot = await track.rpc<Snapshot>(workspaceId, "snapshot", owner);
	const key = snapshot.teams.find((team) => team.id === "team-eng")?.intakeFormKey;
	return `/request/${workspaceId}/${key}`;
}

describe("a deployment that sets its legal pages", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, {
			vars: {
				LEGAL_NOTICE_URL: "https://legal.test/notice?from=track&lang=en",
				PRIVACY_POLICY_URL: "https://legal.test/privacy",
				TERMS_URL: "https://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it.each(SIGN_IN_PAGES)("links them from %s, passing on no address", async (path) => {
		const html = await page(track, path);
		for (const [words, address] of [
			["Legal notice", "https://legal.test/notice?from=track&amp;lang=en"],
			["Privacy", "https://legal.test/privacy"],
			["Terms", "https://legal.test/terms"],
		]) {
			const link = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].find(
				([, attributes, text]) => text === words && attributes?.includes(`href="${address}"`),
			);
			expect(link?.[1], words).toContain('rel="noreferrer"');
		}
	});

	it("links them from a team's public request form, and from what comes after it", async () => {
		const form = await page(track, await aRequestForm(track));
		expect(form).toContain("<form");
		for (const html of [form, await page(track, `/request/none/${"0".repeat(32)}`, 404)]) {
			expect(html).toMatch(
				/<a href="https:\/\/legal\.test\/privacy" [^>]*rel="noreferrer"[^>]*>Privacy<\/a>/,
			);
			expect(html).toContain('href="https://legal.test/notice?from=track&amp;lang=en"');
			expect(html).toContain('href="https://legal.test/terms"');
		}
	});

	it("says at sign-in that continuing means agreeing to the terms", async () => {
		expect(await page(track, "/login")).toContain("By continuing, you agree to the");
		expect(await page(track, "/forgot-password")).not.toContain("By continuing");
	});
});

describe("a deployment that sets none", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin);
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it.each(SIGN_IN_PAGES)("shows nothing of the kind on %s", async (path) => {
		const html = await page(track, path);
		expect(html).not.toContain("Legal notice");
		expect(html).not.toContain("By continuing");
		expect(html).not.toContain('aria-label="Legal"');
		expect(html).not.toContain("gateweave.com");
	});

	it("shows nothing of the kind on a team's public request form", async () => {
		const html = await page(track, await aRequestForm(track));
		expect(html).toContain("<form");
		expect(html).not.toContain("<footer");
		expect(html).not.toContain("gateweave.com");
	});
});

describe("settings that are not addresses people can open", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, {
			vars: {
				LEGAL_NOTICE_URL: "javascript:alert(1)",
				PRIVACY_POLICY_URL: "not an address",
				TERMS_URL: "http://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it("leaves them out, and keeps the one that is", async () => {
		const html = await page(track, "/login");
		expect(html).not.toContain("javascript:alert");
		expect(html).not.toContain("not an address");
		expect(html).not.toMatch(/>Legal notice</);
		expect(html).not.toMatch(/>Privacy</);
		expect(html).toMatch(/<a [^>]*href="http:\/\/legal\.test\/terms"[^>]*>Terms<\/a>/);
	});
});
