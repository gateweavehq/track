import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OIDC_VARS } from "./oidc-provider";
import { startTrack } from "./track-worker";

// Pressed before the page's script has run, a submit button makes the browser send the form itself,
// as a GET, with what was typed in the URL: a password in the address bar, the history and any log
// of requests (TRK-85). So what matters is the HTML the server sends, and these read it. The
// browser tests wait for the script, and so show that the buttons work once it has run.

const origin = "https://track.test";

type Track = Awaited<ReturnType<typeof startTrack>>;

/** Each opening tag on the page of a button, with the words it starts with. */
async function buttonsOn(track: Track, path: string) {
	const response = await track.fetch(`${origin}${path}`);
	expect(response.status).toBe(200);
	const html = await response.text();
	return [...html.matchAll(/(<button\b[^>]*>)([^<]*)/g)].map(([, tag, words]) => ({
		tag: tag ?? "",
		words: words ?? "",
	}));
}

// The attribute, not the `disabled:` of a class name in the same tag.
const DISABLED = /\sdisabled(=|\s|>)/;

describe("a page before its script", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, {
			vars: { ...OIDC_VARS, GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" },
		});
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it.each([
		["signing in", "/login"],
		["signing up", "/login?mode=sign-up"],
		["choosing a new password", "/reset-password?token=not-checked-until-it-is-sent"],
		["asking for a reset link", "/forgot-password"],
	])("cannot send its form when %s", async (_, path) => {
		const submit = (await buttonsOn(track, path)).filter(({ tag }) =>
			tag.includes('type="submit"'),
		);

		expect(submit).toHaveLength(1);
		expect(submit[0]?.tag).toMatch(DISABLED);
	});

	it("offers no provider until it can go there", async () => {
		const providers = (await buttonsOn(track, "/login")).filter(({ words }) =>
			words.startsWith("Continue with"),
		);

		expect(providers.map(({ words }) => words)).toEqual([
			"Continue with Gateweave",
			"Continue with GitHub",
		]);
		for (const { tag } of providers) expect(tag).toMatch(DISABLED);
	});
});

describe("the demo's page before its script", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, { demo: true });
	});

	afterAll(async () => {
		await track?.dispose();
	});

	it("does not offer a workspace until it can open one", async () => {
		const buttons = await buttonsOn(track, "/login");

		expect(buttons.map(({ words }) => words)).toEqual(["Open a demo workspace"]);
		expect(buttons[0]?.tag).toMatch(DISABLED);
	});
});
