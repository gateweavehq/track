import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Track signs people in with GitHub and never acts for them there, so a token in its database could
// only ever be a liability.

const origin = "https://track.test";
const SECRET = "github-secret-for-tests";

let track: Awaited<ReturnType<typeof startTrack>>;
let clients = 0;

/** GitHub's side of a sign-in. The code is who the person is, and so is the token it becomes. */
async function gitHub(request: Request, url: URL): Promise<Response | undefined> {
	if (url.href === "https://github.com/login/oauth/access_token") {
		const form = new URLSearchParams(await request.text());
		if (form.get("client_secret") !== SECRET) {
			return Response.json({ error: "incorrect_client_credentials" });
		}
		return Response.json({
			access_token: form.get("code"),
			refresh_token: "a-refresh-token",
			expires_in: 28800,
			refresh_token_expires_in: 15811200,
			token_type: "bearer",
			scope: "user:email",
		});
	}
	if (url.host !== "api.github.com") return undefined;
	const id = Number((request.headers.get("authorization") ?? "").replace("Bearer ", ""));
	const email = `github-${id}@example.com`;
	if (url.pathname === "/user") {
		return Response.json({ id, login: `person-${id}`, name: "Grace Hopper", email });
	}
	return Response.json([{ email, primary: true, verified: true }]);
}

beforeAll(async () => {
	track = await startTrack(origin, {
		vars: { GITHUB_CLIENT_ID: "github-client-for-tests", GITHUB_CLIENT_SECRET: SECRET },
		outbound: gitHub,
	});
});

afterAll(async () => {
	await track?.dispose();
});

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

/** The whole way to GitHub and back, as the person with this id. Returns who Track says they are. */
async function signIn(id: number) {
	clients += 1;
	const client = `198.51.100.${clients}`;
	const pressed = await track.fetch(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "/" }),
	});
	expect(pressed.status).toBe(200);
	const { url } = (await pressed.json()) as { url: string };
	const state = new URL(url).searchParams.get("state") ?? "";

	const query = new URLSearchParams({ code: String(id), state });
	const back = await track.fetch(`${origin}/api/auth/callback/github?${query}`, {
		headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
	});
	expect(back.status).toBe(302);

	const session = await track.fetch(`${origin}/api/auth/get-session`, {
		headers: { cookie: cookieOf(back), "cf-connecting-ip": client },
	});
	return (await session.json()) as { user: { id: string; email: string } } | null;
}

function gitHubAccount(id: number) {
	return track.db
		.prepare("SELECT * FROM account WHERE provider_id = 'github' AND account_id = ?")
		.bind(String(id))
		.first<Record<string, unknown>>();
}

const NO_TOKENS = {
	access_token: null,
	refresh_token: null,
	id_token: null,
	access_token_expires_at: null,
	refresh_token_expires_at: null,
};

describe("signing in with GitHub", () => {
	it("keeps none of GitHub's tokens, the first time or the next", async () => {
		const first = await signIn(101);
		expect(first?.user.email).toBe("github-101@example.com");
		expect(await gitHubAccount(101)).toMatchObject(NO_TOKENS);

		const next = await signIn(101);
		expect(next?.user.id).toBe(first?.user.id);
		expect(await gitHubAccount(101)).toMatchObject(NO_TOKENS);
	});

	it("clears the tokens an earlier version kept, and someone can still sign in", async () => {
		const before = await signIn(102);
		await track.db
			.prepare(
				`UPDATE account SET access_token = 'old', refresh_token = 'old', id_token = 'old',
				 access_token_expires_at = 1, refresh_token_expires_at = 1
				 WHERE provider_id = 'github' AND account_id = '102'`,
			)
			.run();
		expect(await gitHubAccount(102)).toMatchObject({ access_token: "old", refresh_token: "old" });

		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0005_clear_github_tokens.sql"),
			"utf8",
		);
		await track.db.prepare(migration).run();
		expect(await gitHubAccount(102)).toMatchObject(NO_TOKENS);

		const after = await signIn(102);
		expect(after?.user.id).toBe(before?.user.id);
	});
});
