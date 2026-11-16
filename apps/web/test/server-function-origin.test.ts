import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Who may call a server function, through the built Worker: a signed-in admin's browser is made
// to call `startGuidedTeam`, which adds a team to their workspace, and `getAccount`, which reads
// their address, from this app's pages and from another site's. The framework's guard decides, and
// only while `src/start.ts` lists it.

const origin = "https://track.test";
const elsewhere = "https://elsewhere.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

let calls = 0;

async function authApi(path: string, cookie: string | null, body: object) {
	const response = await track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			// Each call from its own address, so no limit on one address gets in the way.
			"cf-connecting-ip": `203.0.113.${++calls}`,
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

/** Someone signed in, who owns a workspace with no team yet. */
async function ownerOf(slug: string) {
	const email = `${slug}@origin.test`;
	const response = await authApi("/sign-up/email", null, {
		name: slug,
		email,
		password: "a-long-test-password",
	});
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await authApi("/organization/create", cookie, { name: slug, slug });
	const workspaceId = ((await created.json()) as { id: string }).id;
	return { cookie, email, slug, workspaceId };
}

const teamsOf = async (workspaceId: string) => (await track.directory(workspaceId)).teams;

/** The address the built app serves a server function at, found by its name in the build. */
function serverFnUrl(name: string) {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const id = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!id) throw new Error(`No server function ${name} in the build`);
	return `${origin}/_serverFn/${id}`;
}

/** `{ data }` as the client serializes it (Seroval's JSON), for a string or for nothing. */
function payload(data?: string) {
	const value = data === undefined ? { t: 2, s: 1 } : { t: 1, s: data };
	return JSON.stringify({ t: { t: 10, i: 0, p: { k: ["data"], v: [value] }, o: 0 }, f: 0, m: [] });
}

/** Has the person's browser ask for the guided start, with `headers` saying where from. */
async function startGuidedTeam(
	person: { cookie: string; slug: string },
	headers: Record<string, string>,
) {
	const response = await track.fetch(serverFnUrl("startGuidedTeam"), {
		method: "POST",
		headers: {
			cookie: person.cookie,
			"x-tsr-serverFn": "true",
			accept: "application/json",
			"content-type": "application/json",
			...headers,
		},
		body: payload(person.slug),
	});
	return { status: response.status, text: await response.text() };
}

/** Has the person's browser read their account, a GET, with `headers` saying where from. */
async function getAccount(person: { cookie: string }, headers: Record<string, string>) {
	const response = await track.fetch(
		`${serverFnUrl("getAccount")}?payload=${encodeURIComponent(payload())}`,
		{
			headers: {
				cookie: person.cookie,
				"x-tsr-serverFn": "true",
				accept: "application/json",
				...headers,
			},
		},
	);
	return { status: response.status, text: await response.text() };
}

describe("a server function called from another site", () => {
	it("is refused when the browser says the request is cross-site", async () => {
		const person = await ownerOf("cross-site");
		// What a browser sends for a form or a fetch on another site's page, cookie included.
		const answer = await startGuidedTeam(person, {
			"sec-fetch-site": "cross-site",
			origin: elsewhere,
		});
		expect(answer.status).toBe(403);
		expect(answer.text).toBe("Forbidden");
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused whatever else the request says, as the browser's word comes first", async () => {
		const person = await ownerOf("first-word");
		// `Sec-Fetch-Site` is the browser's own and no page can set it, so this app's origin beside
		// it changes nothing.
		const answer = await startGuidedTeam(person, { "sec-fetch-site": "cross-site", origin });
		expect(answer.status).toBe(403);
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused from another host of the same site", async () => {
		const person = await ownerOf("same-site");
		const answer = await startGuidedTeam(person, {
			"sec-fetch-site": "same-site",
			origin: "https://other.track.test",
		});
		expect(answer.status).toBe(403);
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused by its origin, from a browser that does not say which site", async () => {
		const person = await ownerOf("foreign-origin");
		const answer = await startGuidedTeam(person, { origin: elsewhere });
		expect(answer.status).toBe(403);
		expect(answer.text).toBe("Forbidden");
		expect(await teamsOf(person.workspaceId)).toEqual([]);

		// A page in a sandboxed frame, or a document from a `data:` address.
		expect((await startGuidedTeam(person, { origin: "null" })).status).toBe(403);
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused by its referrer, when that is all the request has", async () => {
		const person = await ownerOf("referrer");
		const answer = await startGuidedTeam(person, { referer: `${elsewhere}/page` });
		expect(answer.status).toBe(403);
		// An address that only begins as this app's does is another host.
		const lookalike = await startGuidedTeam(person, { referer: `${origin}.elsewhere.test/` });
		expect(lookalike.status).toBe(403);
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused when the request says nothing of where it is from", async () => {
		const person = await ownerOf("unsaid");
		const answer = await startGuidedTeam(person, {});
		expect(answer.status).toBe(403);
		expect(await teamsOf(person.workspaceId)).toEqual([]);
	});

	it("is refused a read as well, so a link that is followed shows nothing", async () => {
		const person = await ownerOf("read");
		// A link on another site's page: the browser sends the cookie along, as it is `SameSite=Lax`.
		const followed = await getAccount(person, {
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
			"sec-fetch-dest": "document",
		});
		expect(followed.status).toBe(403);
		expect(followed.text).not.toContain(person.email);

		const fetched = await getAccount(person, { origin: elsewhere });
		expect(fetched.status).toBe(403);
		expect(fetched.text).not.toContain(person.email);
	});
});

describe("a server function called from the app's own pages", () => {
	it("is answered when the browser says the request is same-origin", async () => {
		const person = await ownerOf("same-origin");
		const answer = await startGuidedTeam(person, { "sec-fetch-site": "same-origin", origin });
		expect(answer.status).toBe(200);
		expect(await teamsOf(person.workspaceId)).toHaveLength(1);

		const account = await getAccount(person, { "sec-fetch-site": "same-origin" });
		expect(account.status).toBe(200);
		expect(account.text).toContain(person.email);
	});

	it("is answered by its origin, from a browser that does not say which site", async () => {
		const person = await ownerOf("own-origin");
		const answer = await startGuidedTeam(person, { origin });
		expect(answer.status).toBe(200);
		expect(await teamsOf(person.workspaceId)).toHaveLength(1);

		const account = await getAccount(person, { origin });
		expect(account.status).toBe(200);
		expect(account.text).toContain(person.email);
	});

	it("is answered by its referrer, when that is all the request has", async () => {
		const person = await ownerOf("own-referrer");
		const answer = await startGuidedTeam(person, { referer: `${origin}/own-referrer` });
		expect(answer.status).toBe(200);
		expect(await teamsOf(person.workspaceId)).toHaveLength(1);
	});
});
