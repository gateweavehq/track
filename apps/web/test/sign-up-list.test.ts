import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OIDC, OIDC_VARS, standInProvider } from "./oidc-provider";
import { startTrack } from "./track-worker";

// Sign-up by the server owner's list (TRK-123). While the owner has closed sign-up, an account needs
// a way in whatever makes it: the list, a workspace's invitation, or the provider they trust. Every
// refusal says the same words and nothing about whether the address has an account.

const origin = "https://track.test";
const PASSWORD = "a-long-test-password";
const GITHUB_SECRET = "github-secret-for-tests";
const REFUSAL = {
	code: "SIGN_UP_CLOSED",
	message: "This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

type Track = Awaited<ReturnType<typeof startTrack>>;
type Provider = Awaited<ReturnType<typeof standInProvider>>;

/** Each call comes from its own address, because sign-ins are limited per address. */
let clients = 0;
function newClient() {
	clients += 1;
	return `203.0.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

function authApi(
	track: Track,
	path: string,
	init: { cookie?: string; body?: object; method?: "GET" | "POST" } = {},
) {
	const method = init.method ?? (init.body ? "POST" : "GET");
	return track.fetch(`${origin}/api/auth${path}`, {
		method,
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			...(method === "POST" && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
		},
		body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
	});
}

interface Person {
	id: string;
	email: string;
	cookie: string;
}

/** Signs up with a password and expects it to work. */
async function signUp(track: Track, email: string): Promise<Person> {
	const response = await signUpResponse(track, email);
	expect(response.status, await response.clone().text()).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	return { id: user.id, email, cookie: cookieOf(response) };
}

function signUpResponse(track: Track, email: string) {
	return authApi(track, "/sign-up/email", {
		body: { name: "Test Person", email, password: PASSWORD },
	});
}

async function userCount(track: Track, email: string) {
	const row = await track.db
		.prepare("SELECT count(*) AS n FROM user WHERE email = ?")
		.bind(email)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function deploymentRow(track: Track) {
	return track.db
		.prepare("SELECT owner_id, sign_up, trust_provider FROM deployment WHERE id = 1")
		.first<{ owner_id: string | null; sign_up: string; trust_provider: number }>();
}

/** What an endpoint answers with, status and body. */
async function answer(response: Response) {
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Not JSON: a 404 has none.
	}
	return { status: response.status, body };
}

async function post(track: Track, who: { cookie: string }, path: string, body: object) {
	return answer(await authApi(track, path, { cookie: who.cookie, body }));
}

async function get(track: Track, who: { cookie: string }, path: string) {
	return answer(await authApi(track, path, { cookie: who.cookie }));
}

/** Makes the session older than a day, which is as old as a session may be to change the list. */
async function makeStale(track: Track, userId: string) {
	await track.db
		.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
		.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, userId)
		.run();
}

// GitHub's side of a sign-in: the code is who the person is, and so is the token it becomes.
async function gitHub(request: Request, url: URL): Promise<Response | undefined> {
	if (url.href === "https://github.com/login/oauth/access_token") {
		const form = new URLSearchParams(await request.text());
		return Response.json({
			access_token: form.get("code"),
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

/** Where Track sends the browser after a sign-in through GitHub as person `id`, and its cookie. */
async function signInWithGitHub(track: Track, id: number) {
	const client = newClient();
	const pressed = await track.fetch(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({
			provider: "github",
			callbackURL: "/",
			errorCallbackURL: "/login",
		}),
	});
	const { url } = (await pressed.json()) as { url: string };
	const query = new URLSearchParams({
		code: String(id),
		state: new URL(url).searchParams.get("state") ?? "",
	});
	const back = await track.fetch(`${origin}/api/auth/callback/github?${query}`, {
		headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
	});
	expect(back.status).toBe(302);
	return {
		location: new URL(back.headers.get("location") ?? "", origin),
		cookie: cookieOf(back),
	};
}

/** The whole way to the provider and back as this person. */
async function signInWithProvider(
	track: Track,
	provider: Provider,
	person: { sub: string; email: string },
) {
	const client = newClient();
	const pressed = await track.fetch(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" }),
	});
	const { url } = (await pressed.json()) as { url: string };
	const authorize = new URL(url);
	const code = provider.grant(authorize, { name: "Pat Provider", email_verified: true, ...person });
	const query = new URLSearchParams({
		code,
		state: authorize.searchParams.get("state") ?? "",
		iss: OIDC.issuer,
	});
	const back = await track.fetch(`${origin}/api/auth/callback/oidc?${query}`, {
		headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
	});
	expect(back.status).toBe(302);
	return {
		location: new URL(back.headers.get("location") ?? "", origin),
		cookie: cookieOf(back),
	};
}

async function signedIn(track: Track, cookie: string) {
	const response = await track.fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
	return (await response.json()) !== null;
}

describe("a server whose owner has closed sign-up", () => {
	let track: Track;
	let provider: Provider;
	let owner: Person;

	beforeAll(async () => {
		provider = await standInProvider();
		track = await startTrack(origin, {
			vars: {
				...OIDC_VARS,
				GITHUB_CLIENT_ID: "github-client-for-tests",
				GITHUB_CLIENT_SECRET: GITHUB_SECRET,
			},
			outbound: async (request, url) =>
				(await gitHub(request, url)) ?? provider.outbound(request, url),
		});
		// The first account on a server with none owns it, and a new server is open.
		owner = await signUp(track, "owner@track.test");
	});

	afterAll(async () => {
		await track?.dispose();
	});

	async function add(entry: string, note?: string) {
		return post(track, owner, "/deployment/allow/add", { entry, ...(note && { note }) });
	}

	it("starts open, with its first account as the owner", async () => {
		expect(await deploymentRow(track)).toEqual({
			owner_id: owner.id,
			sign_up: "open",
			trust_provider: 0,
		});
		// Open means anyone, as before.
		await signUp(track, "anyone@elsewhere.test");
	});

	it("turns away an address that is not on the list, in the same words on every path", async () => {
		expect(await post(track, owner, "/deployment/sign-up", { signUp: "closed" })).toMatchObject({
			status: 200,
		});

		// A password. The owner's own address has an account, and gets the very same answer.
		const stranger = await answer(await signUpResponse(track, "stranger@elsewhere.test"));
		const existing = await answer(await signUpResponse(track, "owner@track.test"));
		const listedNowhere = await answer(await signUpResponse(track, "anyone@elsewhere.test"));
		for (const refused of [stranger, existing, listedNowhere]) {
			expect(refused.status).toBe(403);
			expect(refused.body).toMatchObject(REFUSAL);
		}
		expect(stranger.body).toEqual(existing.body);
		expect(await userCount(track, "stranger@elsewhere.test")).toBe(0);

		// GitHub and the provider come back to the sign-in page with the same code, and no session.
		const github = await signInWithGitHub(track, 801);
		expect(github.location.pathname).toBe("/login");
		expect(github.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await signedIn(track, github.cookie)).toBe(false);
		expect(await userCount(track, "github-801@example.com")).toBe(0);

		const oidc = await signInWithProvider(track, provider, {
			sub: "sub-stranger",
			email: "provider-stranger@elsewhere.test",
		});
		expect(oidc.location.pathname).toBe("/login");
		expect(oidc.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await signedIn(track, oidc.cookie)).toBe(false);
		expect(await userCount(track, "provider-stranger@elsewhere.test")).toBe(0);

		// Nobody was told anything by email.
		const sent = (await track.emails()).map((email) => email.to);
		expect(sent).not.toContain("stranger@elsewhere.test");
	});

	it("is held by the database too, for a path that forgets to ask", async () => {
		await expect(
			track.db
				.prepare(
					"INSERT INTO user (id, name, email, email_verified) VALUES ('sneaky', 'Sneaky', 'sneaky@elsewhere.test', 1)",
				)
				.run(),
		).rejects.toThrow(/sign-up is closed here/);
		expect(await userCount(track, "sneaky@elsewhere.test")).toBe(0);
	});

	it("lets in an address on the list, and one at a listed domain, but not a subdomain", async () => {
		expect((await add("ada@example.com")).status).toBe(200);
		expect((await add("@corp.test")).status).toBe(200);

		await signUp(track, "ada@example.com");
		await signUp(track, "bob@corp.test");
		// The list is read in lowercase, as an address is.
		await signUp(track, "Eve@CORP.test");

		for (const email of [
			"carol@sub.corp.test",
			"dave@corp.test.evil.test",
			"ada@example.org",
			"ada2@example.com",
			"corp.test@elsewhere.test",
		]) {
			const refused = await answer(await signUpResponse(track, email));
			expect(refused.status, email).toBe(403);
			expect(refused.body).toMatchObject(REFUSAL);
			expect(await userCount(track, email)).toBe(0);
		}
	});

	it("lets the list in through GitHub and the provider as well", async () => {
		await add("github-802@example.com");
		await add("provider-friend@elsewhere.test");

		const github = await signInWithGitHub(track, 802);
		expect(github.location.pathname).toBe("/");
		expect(await signedIn(track, github.cookie)).toBe(true);

		const oidc = await signInWithProvider(track, provider, {
			sub: "sub-friend",
			email: "provider-friend@elsewhere.test",
		});
		expect(oidc.location.pathname).toBe("/");
		expect(await signedIn(track, oidc.cookie)).toBe(true);
	});

	it("still lets an invited address in, until the invitation is no longer pending", async () => {
		const made = await post(track, owner, "/organization/create", { name: "Acme", slug: "acme" });
		const workspaceId = (made.body as { id: string }).id;
		const invite = async (email: string) => {
			const sent = await post(track, owner, "/organization/invite-member", {
				email,
				role: "member",
				organizationId: workspaceId,
			});
			expect(sent.status, JSON.stringify(sent.body)).toBe(200);
			return (sent.body as { id: string }).id;
		};

		await invite("invited@nowhere.test");
		await signUp(track, "invited@nowhere.test");

		// Past its week, and cancelled, it is no way in.
		const late = await invite("late@nowhere.test");
		await track.db
			.prepare("UPDATE invitation SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, late)
			.run();
		const withdrawn = await invite("withdrawn@nowhere.test");
		await track.db
			.prepare("UPDATE invitation SET status = 'canceled' WHERE id = ?")
			.bind(withdrawn)
			.run();
		for (const email of ["late@nowhere.test", "withdrawn@nowhere.test"]) {
			const refused = await answer(await signUpResponse(track, email));
			expect(refused.status, email).toBe(403);
			expect(refused.body).toMatchObject(REFUSAL);
		}
	});

	it("trusts the provider only when the owner says, and never GitHub", async () => {
		const state = async () => (await get(track, owner, "/deployment/get")).body;
		expect(await state()).toMatchObject({ trustProvider: false, provider: "Gateweave" });

		// Trust off: the provider's own list is not enough.
		const before = await signInWithProvider(track, provider, {
			sub: "sub-trusted-1",
			email: "trusted-1@elsewhere.test",
		});
		expect(before.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");

		const turnedOn = await post(track, owner, "/deployment/trust-provider", { trust: true });
		expect(turnedOn).toMatchObject({ status: 200, body: { trustProvider: true } });
		expect(await state()).toMatchObject({ trustProvider: true });

		const trusted = await signInWithProvider(track, provider, {
			sub: "sub-trusted-2",
			email: "trusted-2@elsewhere.test",
		});
		expect(trusted.location.pathname).toBe("/");
		expect(await signedIn(track, trusted.cookie)).toBe(true);
		// The pass the hook wrote is spent once the account exists.
		expect(await passCount()).toBe(0);

		// The database lets none through on trust alone: without a pass, or with an expired one, it
		// refuses an address, whichever sign-in it came from.
		const insert = (email: string) =>
			track.db
				.prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, 'X', ?, 1)")
				.bind(`direct-${email}`, email)
				.run();
		await expect(insert("direct-1@elsewhere.test")).rejects.toThrow(/sign-up is closed here/);
		await track.db
			.prepare("INSERT INTO sign_up_pass (email, expires_at) VALUES (?, ?)")
			.bind("direct-2@elsewhere.test", Date.now() - 1000)
			.run();
		await expect(insert("direct-2@elsewhere.test")).rejects.toThrow(/sign-up is closed here/);
		// A pass is for one address and lets exactly that one in.
		await track.db
			.prepare("INSERT INTO sign_up_pass (email, expires_at) VALUES (?, ?)")
			.bind("direct-3@elsewhere.test", Date.now() + 60_000)
			.run();
		await expect(insert("direct-4@elsewhere.test")).rejects.toThrow(/sign-up is closed here/);
		await insert("direct-3@elsewhere.test");

		// GitHub, a password and an unlisted address are held to the list as before.
		const github = await signInWithGitHub(track, 803);
		expect(github.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await userCount(track, "github-803@example.com")).toBe(0);
		const password = await answer(await signUpResponse(track, "trusted-3@elsewhere.test"));
		expect(password).toMatchObject({ status: 403, body: REFUSAL });

		// Turned off again, the provider is held to it too.
		await post(track, owner, "/deployment/trust-provider", { trust: false });
		const after = await signInWithProvider(track, provider, {
			sub: "sub-trusted-4",
			email: "trusted-4@elsewhere.test",
		});
		expect(after.location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await userCount(track, "trusted-4@elsewhere.test")).toBe(0);
	});

	it("shows its list to the owner, with who has an account", async () => {
		const { body } = await get(track, owner, "/deployment/get");
		const listed = body as {
			total: number;
			signUp: string;
			entries: { entry: string; hasAccount: boolean; note: string | null }[];
		};
		expect(listed.signUp).toBe("closed");
		const byEntry = new Map(listed.entries.map((each) => [each.entry, each]));
		expect(byEntry.get("ada@example.com")?.hasAccount).toBe(true);
		expect(byEntry.get("@corp.test")?.hasAccount).toBe(true);
		expect(byEntry.get("github-802@example.com")?.hasAccount).toBe(true);
	});

	describe("the endpoints", () => {
		const PATHS: [string, object][] = [
			["/deployment/sign-up", { signUp: "open" }],
			["/deployment/trust-provider", { trust: true }],
			["/deployment/allow/add", { entry: "mallory@elsewhere.test" }],
			["/deployment/allow/remove", { entry: "ada@example.com" }],
		];

		it("are not there for anyone who does not run the server", async () => {
			const member = await signInWithCookie("ada@example.com");
			expect((await get(track, member, "/deployment/get")).status).toBe(404);
			for (const [path, body] of PATHS) {
				expect((await post(track, member, path, body)).status, path).toBe(404);
			}
			// Nor for someone signed out.
			expect((await answer(await authApi(track, "/deployment/get"))).status).toBe(401);
			expect((await deploymentRow(track))?.sign_up).toBe("closed");
			expect(await userCount(track, "mallory@elsewhere.test")).toBe(0);
		});

		it("want a recent sign-in to change anything, and show the list without one", async () => {
			const stale = await signInWithCookie("owner@track.test", PASSWORD);
			await makeStale(track, owner.id);
			await makeStale(track, stale.id);

			for (const [path, body] of PATHS) {
				const refused = await post(track, stale, path, body);
				expect(refused.status, path).toBe(403);
				expect(refused.body, path).toMatchObject({ code: "SESSION_NOT_FRESH" });
			}
			expect(await deploymentRow(track)).toMatchObject({ sign_up: "closed", trust_provider: 0 });
			const listed = await get(track, stale, "/deployment/get");
			expect(listed.status).toBe(200);
			expect(
				await track.db
					.prepare("SELECT 1 FROM sign_up_allow WHERE entry = 'ada@example.com'")
					.first(),
			).not.toBeNull();
			expect(await userCount(track, "mallory@elsewhere.test")).toBe(0);

			// A fresh sign-in works again.
			const fresh = await signInWithCookie("owner@track.test", PASSWORD);
			expect(
				(await post(track, fresh, "/deployment/allow/add", { entry: "fresh@elsewhere.test" }))
					.status,
			).toBe(200);
			expect(
				(await post(track, fresh, "/deployment/allow/remove", { entry: "fresh@elsewhere.test" }))
					.status,
			).toBe(200);
			owner = { ...owner, cookie: fresh.cookie };
		});
	});

	async function passCount() {
		const row = await track.db.prepare("SELECT count(*) AS n FROM sign_up_pass").first<{
			n: number;
		}>();
		return row?.n ?? 0;
	}

	/** Signs in with a password, which makes a session of its own. */
	async function signInWithCookie(email: string, password = PASSWORD) {
		const response = await authApi(track, "/sign-in/email", { body: { email, password } });
		expect(response.status).toBe(200);
		const { user } = (await response.json()) as { user: { id: string } };
		return { id: user.id, cookie: cookieOf(response) };
	}

	describe("the list", () => {
		it("takes an address or a domain as the owner types it, and keeps a note", async () => {
			const added = await add("  Grace@Example.NET ", "  from the waitlist ");
			expect(added).toMatchObject({ status: 200, body: { entry: "grace@example.net" } });
			const row = await track.db
				.prepare("SELECT entry, note, added_by FROM sign_up_allow WHERE entry = ?")
				.bind("grace@example.net")
				.first();
			expect(row).toEqual({
				entry: "grace@example.net",
				note: "from the waitlist",
				added_by: owner.id,
			});
			expect((await add("@Example.Net")).body).toMatchObject({ entry: "@example.net" });
		});

		it("refuses what is not an address or a domain, a long note and a second entry", async () => {
			for (const entry of [
				"",
				"nobody",
				"@",
				"@nodots",
				"a@b",
				"two words@example.com",
				"@sub..example.com",
				"@-example.com",
				"x@@example.com",
				"@x@example.com",
				"*@example.com",
				`${"a".repeat(250)}@example.com`,
			]) {
				const refused = await add(entry);
				expect(refused.status, entry).toBe(400);
			}
			expect((await add("fine@example.com", "x".repeat(201))).status).toBe(400);
			expect((await add("fine@example.com", "x".repeat(200))).status).toBe(200);
			const twice = await add("fine@example.com");
			expect(twice).toMatchObject({ status: 400, body: { code: "ALREADY_ON_THE_LIST" } });
		});

		it("searches by entry or note, and counts", async () => {
			await add("waitlisted@elsewhere.test", "Came From The Waitlist");
			const found = (await get(track, owner, "/deployment/get?q=waitlist")).body as {
				entries: { entry: string }[];
				matching: number;
				total: number;
			};
			expect(found.entries.map((each) => each.entry).sort()).toEqual([
				"grace@example.net",
				"waitlisted@elsewhere.test",
			]);
			expect(found.matching).toBe(2);
			expect(found.total).toBeGreaterThan(found.matching);
			const none = (await get(track, owner, "/deployment/get?q=no-such-thing")).body as {
				entries: unknown[];
				matching: number;
			};
			expect(none).toMatchObject({ entries: [], matching: 0 });
		});

		it("lets someone in until their entry is removed", async () => {
			expect((await add("temp@elsewhere.test")).status).toBe(200);
			await signUp(track, "temp@elsewhere.test");
			expect((await add("gone@elsewhere.test")).status).toBe(200);

			const removed = await post(track, owner, "/deployment/allow/remove", {
				entry: " Gone@elsewhere.test ",
			});
			expect(removed).toMatchObject({ status: 200 });
			const refused = await answer(await signUpResponse(track, "gone@elsewhere.test"));
			expect(refused).toMatchObject({ status: 403, body: REFUSAL });

			const missing = await post(track, owner, "/deployment/allow/remove", {
				entry: "gone@elsewhere.test",
			});
			expect(missing).toMatchObject({ status: 404, body: { code: "NOT_ON_THE_LIST" } });
			// An account made through an entry stays when the entry goes.
			expect(await userCount(track, "temp@elsewhere.test")).toBe(1);
			await post(track, owner, "/deployment/allow/remove", { entry: "temp@elsewhere.test" });
			expect(await userCount(track, "temp@elsewhere.test")).toBe(1);
		});

		it("holds at most 5,000 entries, by the endpoint and by the database", async () => {
			const { n } = (await track.db.prepare("SELECT count(*) AS n FROM sign_up_allow").first<{
				n: number;
			}>()) ?? { n: 0 };
			await track.db
				.prepare(
					`WITH RECURSIVE counting(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM counting WHERE i < ?)
					 INSERT INTO sign_up_allow (entry, note, added_at, added_by)
					 SELECT 'filler-' || i || '@filler.test', NULL, 0, 'test' FROM counting`,
				)
				.bind(5000 - n)
				.run();

			const full = await add("one-too-many@elsewhere.test");
			expect(full).toMatchObject({ status: 400, body: { code: "SIGN_UP_LIST_FULL" } });
			await expect(
				track.db
					.prepare(
						"INSERT INTO sign_up_allow (entry, note, added_at, added_by) VALUES ('sneaky@filler.test', NULL, 0, 'test')",
					)
					.run(),
			).rejects.toThrow(/list is full/);

			await track.db.prepare("DELETE FROM sign_up_allow WHERE entry LIKE 'filler-%'").run();
		});

		it("takes only lowercase entries and short notes, whatever adds them", async () => {
			await expect(
				track.db
					.prepare(
						"INSERT INTO sign_up_allow (entry, note, added_at, added_by) VALUES ('Mixed@Case.test', NULL, 0, 'x')",
					)
					.run(),
			).rejects.toThrow();
			await expect(
				track.db
					.prepare(
						"INSERT INTO sign_up_allow (entry, note, added_at, added_by) VALUES ('long@note.test', ?, 0, 'x')",
					)
					.bind("x".repeat(201))
					.run(),
			).rejects.toThrow();
		});
	});

	it("lets the owner make agents, which are not people signing up", async () => {
		const made = await post(track, owner, "/organization/create", {
			name: "Robots",
			slug: "robots",
		});
		const organizationId = (made.body as { id: string }).id;
		const agent = await post(track, owner, "/agents/create", { organizationId, name: "Bot" });
		expect(agent.status, JSON.stringify(agent.body)).toBe(200);
	});

	it("keeps its owner's account while it is closed, and says why", async () => {
		const fresh = await signInWithCookie("owner@track.test");
		const refused = await post(track, fresh, "/account/delete", { password: PASSWORD });
		expect(refused).toMatchObject({ status: 403, body: { code: "RUNS_THE_SERVER" } });
		expect(await userCount(track, "owner@track.test")).toBe(1);
		await expect(
			track.db.prepare("DELETE FROM user WHERE id = ?").bind(owner.id).run(),
		).rejects.toThrow(/must keep its owner/);
	});

	it("lets anyone make an account again once the owner opens it", async () => {
		const fresh = await signInWithCookie("owner@track.test");
		expect(await post(track, fresh, "/deployment/sign-up", { signUp: "open" })).toMatchObject({
			status: 200,
		});
		await signUp(track, "open-again@elsewhere.test");
		expect((await github())?.location.pathname).toBe("/");

		async function github() {
			return signInWithGitHub(track, 804);
		}
	});

	it("lets the owner's account go once the server is open", async () => {
		// A workspace needs an owner, so the ones they made go first.
		await track.db.prepare("DELETE FROM organization").run();
		const fresh = await signInWithCookie("owner@track.test");
		const gone = await post(track, fresh, "/account/delete", { password: PASSWORD });
		expect(gone.status, JSON.stringify(gone.body)).toBe(200);
		// The earliest account left that is a person takes over.
		const next = await track.db
			.prepare(
				"SELECT id FROM user WHERE email NOT LIKE '%@agents.invalid' ORDER BY created_at, id LIMIT 1",
			)
			.first<{ id: string }>();
		expect(next?.id).toBeTruthy();
		expect((await deploymentRow(track))?.owner_id).toBe(next?.id);
	});
});

describe("a server whose owner leaves", () => {
	it("is left with no owner only when nobody is left, and the next account takes it", async () => {
		const track = await startTrack(origin);
		try {
			const only = await signUp(track, "only@track.test");
			// An agent is not a person, and is never next in line.
			await track.db
				.prepare(
					"INSERT INTO user (id, name, email, email_verified, created_at) VALUES ('bot', 'Bot', 'bot@agents.invalid', 0, 1)",
				)
				.run();
			const gone = await post(track, await signInAs(track, only.email), "/account/delete", {
				password: PASSWORD,
			});
			expect(gone.status, JSON.stringify(gone.body)).toBe(200);
			expect((await deploymentRow(track))?.owner_id).toBeNull();

			const next = await signUp(track, "next@track.test");
			expect((await deploymentRow(track))?.owner_id).toBe(next.id);
		} finally {
			await track.dispose();
		}
	});
});

async function signInAs(track: Track, email: string) {
	const response = await authApi(track, "/sign-in/email", { body: { email, password: PASSWORD } });
	expect(response.status).toBe(200);
	return { cookie: cookieOf(response) };
}

describe("a server with no accounts, closed", () => {
	let track: Track;

	beforeAll(async () => {
		track = await startTrack(origin, {
			vars: { SIGN_UP_REQUEST_URL: "https://gateweave.com/waitlist" },
		});
		await track.db.prepare("UPDATE deployment SET sign_up = 'closed'").run();
	});

	afterAll(async () => {
		await track?.dispose();
	});

	const login = async () => (await track.fetch(`${origin}/login`)).text();

	it("does not call itself closed to whoever is first, and offers no way to ask", async () => {
		const html = await login();
		expect(html).not.toContain("Ask for access");
		expect(html).not.toContain("takes new accounts by invitation");
	});

	it("makes the first account its owner, and turns the second away", async () => {
		const first = await signUp(track, "first@track.test");
		expect(await deploymentRow(track)).toMatchObject({ owner_id: first.id, sign_up: "closed" });

		const second = await answer(await signUpResponse(track, "second@track.test"));
		expect(second).toMatchObject({ status: 403, body: REFUSAL });
	});

	it("links to where someone can ask for access, once it is closed to them", async () => {
		const html = await login();
		expect(html).toContain("This server takes new accounts by invitation");
		expect(html).toMatch(/href="https:\/\/gateweave\.com\/waitlist"[^>]*>Ask for access</);
	});

	it("has no setting for a provider it does not have", async () => {
		const owner = await (async () => {
			const response = await authApi(track, "/sign-in/email", {
				body: { email: "first@track.test", password: PASSWORD },
			});
			return { cookie: cookieOf(response) };
		})();
		expect(await get(track, owner, "/deployment/get")).toMatchObject({
			status: 200,
			body: { provider: null, trustProvider: false },
		});
		expect((await post(track, owner, "/deployment/trust-provider", { trust: true })).status).toBe(
			404,
		);
	});

	it("keeps the oldest account as the owner when an upgrade finds accounts", async () => {
		// What the migration does to a server that already has accounts, with an earlier one and an
		// agent that came before them all.
		await track.db.prepare("UPDATE deployment SET sign_up = 'open'").run();
		await track.db
			.prepare(
				`INSERT INTO user (id, name, email, email_verified, created_at) VALUES
				 ('agent-0', 'Bot', 'agent-0@agents.invalid', 0, 1),
				 ('old-1', 'Old', 'old@track.test', 1, 2)`,
			)
			.run();
		await track.db.prepare("DELETE FROM deployment").run();
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0011_sign_up_holds.sql"),
			"utf8",
		);
		const [insert] = migration.split("--> statement-breakpoint");
		await track.db.prepare(insert ?? "").run();

		expect(await deploymentRow(track)).toEqual({
			owner_id: "old-1",
			sign_up: "open",
			trust_provider: 0,
		});
	});
});

describe("a link to ask for access", () => {
	it("is left out unless it is an https address", async () => {
		const track = await startTrack(origin, {
			vars: { SIGN_UP_REQUEST_URL: "http://insecure.test/" },
		});
		try {
			await signUp(track, "someone@track.test");
			await track.db.prepare("UPDATE deployment SET sign_up = 'closed'").run();
			const html = await (await track.fetch(`${origin}/login`)).text();
			expect(html).toContain("This server takes new accounts by invitation");
			expect(html).not.toContain("Ask for access");
			expect(html).not.toContain("insecure.test");
		} finally {
			await track.dispose();
		}
	});
});
