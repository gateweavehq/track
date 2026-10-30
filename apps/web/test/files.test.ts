import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

// Attached files (TRK-35) in the built Worker: the gateway in front of R2 lets members of a
// workspace upload and read its files, answers everyone else as if there were none, and never
// lets a file run as a page of the app.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

interface Person {
	id: string;
	cookie: string;
}

async function signUp(client: string, name: string, email: string): Promise<Person> {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, cookie };
}

async function createWorkspace(client: string, owner: Person, slug: string): Promise<string> {
	const response = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: {
			origin,
			cookie: owner.cookie,
			"cf-connecting-ip": client,
			"content-type": "application/json",
		},
		body: JSON.stringify({ name: slug, slug }),
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	return ((await response.json()) as { id: string }).id;
}

function upload(
	path: string,
	person: Person | null,
	body: BodyInit,
	headers: Record<string, string> = {},
) {
	return track.fetch(`${origin}${path}`, {
		method: "PUT",
		headers: { origin, ...(person && { cookie: person.cookie }), ...headers },
		body,
	});
}

function download(path: string, person: Person | null, headers: Record<string, string> = {}) {
	return track.fetch(`${origin}${path}`, {
		headers: { ...(person && { cookie: person.cookie }), ...headers },
	});
}

// The smallest PNG there is: one transparent pixel.
const PIXEL = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	),
	(char) => char.charCodeAt(0),
);

describe("attached files", () => {
	let maya: Person;
	let sam: Person;
	let outsider: Person;
	let acme: string;

	beforeAll(async () => {
		const client = "203.0.113.80";
		maya = await signUp(client, "Maya", "maya@files.test");
		sam = await signUp(client, "Sam", "sam@files.test");
		outsider = await signUp(client, "Olga", "olga@files.test");
		acme = await createWorkspace(client, maya, "acme-files");
		await track.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), acme, sam.id, "member", Date.now())
			.run();
	});

	it("lets a member upload a file that every member, and nobody else, can open", async () => {
		const path = `/api/files/${acme}/${crypto.randomUUID()}/screenshot.png`;
		const created = await upload(path, maya, PIXEL, { "content-type": "image/png" });
		expect(created.status).toBe(201);

		const shown = await download(path, sam);
		expect(shown.status).toBe(200);
		expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PIXEL);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("content-disposition")).toMatch(/^inline; /);
		expect(shown.headers.get("cache-control")).toContain("private");

		// Someone else gets what a file that does not exist gets, and so does a stranger.
		const missing = await download(`/api/files/${acme}/${crypto.randomUUID()}/screenshot.png`, sam);
		expect(missing.status).toBe(404);
		expect((await download(path, outsider)).status).toBe(404);
		expect(await (await download(path, outsider)).text()).toBe(await missing.text());
		expect((await download(path, null)).status).toBe(401);

		// A file stays as it was uploaded, even when its link is uploaded to again.
		expect(
			(await upload(path, sam, "something else", { "content-type": "text/plain" })).status,
		).toBe(409);
		expect(new Uint8Array(await (await download(path, maya)).arrayBuffer())).toEqual(PIXEL);
	});

	it("never serves a file as a page of the app", async () => {
		for (const [name, type] of [
			["page.html", "text/html"],
			["drawing.svg", "image/svg+xml"],
			["script.js", "text/javascript"],
			["unknown.bin", ""],
		] as const) {
			const path = `/api/files/${acme}/${crypto.randomUUID()}/${name}`;
			// Bytes, so that fetch sends no type of its own when the test gives none.
			const body = new TextEncoder().encode("<script>alert(document.cookie)</script>");
			const created = await upload(path, maya, body, { ...(type && { "content-type": type }) });
			expect(created.status).toBe(201);
			const served = await download(path, maya);
			expect(served.headers.get("content-type")).toBe("application/octet-stream");
			expect(served.headers.get("content-disposition")).toBe(
				`attachment; filename="${name}"; filename*=UTF-8''${name}`,
			);
			expect(served.headers.get("x-content-type-options")).toBe("nosniff");
			expect(served.headers.get("content-security-policy")).toContain("sandbox");
		}
	});

	it("keeps uploads to the app, to a size, and to names it gave", async () => {
		const path = (name = "notes.txt") => `/api/files/${acme}/${crypto.randomUUID()}/${name}`;
		const text = { "content-type": "text/plain" };

		// Cookies ride along with a request from another site.
		expect(
			(await upload(path(), maya, "hello", { ...text, origin: "https://evil.test" })).status,
		).toBe(403);
		expect((await upload(path(), null, "hello", text)).status).toBe(401);
		expect((await upload(path(), outsider, "hello", text)).status).toBe(404);
		// The Worker answers before reading the body, so under load the test's client can see the
		// connection close before the answer. Either way, nothing is stored.
		const tooLarge = path("large.bin");
		const answer = await upload(tooLarge, maya, new Uint8Array(25 * 1024 * 1024 + 1), text).then(
			(response) => response.status,
			(error: unknown) =>
				String(error).includes("fetch failed") ? "closed" : Promise.reject(error),
		);
		expect([413, "closed"]).toContain(answer);
		expect(await track.fileKeys(`${acme}/${tooLarge.split("/")[4]}/`)).toEqual([]);
		// The browser cleans a file's name before linking it; anything else is not a link it made.
		expect((await upload(path("..%2Fescape.txt"), maya, "hello", text)).status).toBe(404);
		expect((await upload(path(".env"), maya, "hello", text)).status).toBe(404);
		expect(
			(await upload(`/api/files/${acme}/not-an-id/notes.txt`, maya, "hello", text)).status,
		).toBe(404);
	});

	it("serves part of a file and revalidates the rest", async () => {
		const path = `/api/files/${acme}/${crypto.randomUUID()}/count.txt`;
		await upload(path, maya, "0123456789", { "content-type": "text/plain" });

		const part = await download(path, sam, { range: "bytes=2-5" });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("2345");
		expect(part.headers.get("content-range")).toBe("bytes 2-5/10");

		const whole = await download(path, sam);
		expect(whole.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const etag = whole.headers.get("etag");
		expect(etag).toBeTruthy();
		const again = await download(path, sam, { "if-none-match": etag ?? "" });
		expect(again.status).toBe(304);
	});

	it("deletes a workspace's files with the workspace", async () => {
		const client = "203.0.113.81";
		const owner = await signUp(client, "Wes", "wes@files.test");
		const doomed = await createWorkspace(client, owner, "doomed-files");
		for (const name of ["a.txt", "b.txt"]) {
			await upload(`/api/files/${doomed}/${crypto.randomUUID()}/${name}`, owner, name, {
				"content-type": "text/plain",
			});
		}
		expect(await track.fileKeys(`${doomed}/`)).toHaveLength(2);

		const deleted = await track.fetch(`${origin}/api/auth/organization/delete`, {
			method: "POST",
			headers: {
				origin,
				cookie: owner.cookie,
				"cf-connecting-ip": client,
				"content-type": "application/json",
			},
			body: JSON.stringify({ organizationId: doomed }),
		});
		expect(deleted.status).toBe(200);
		// The files go after the response.
		await vi.waitFor(async () => expect(await track.fileKeys(`${doomed}/`)).toHaveLength(0));
		// Other workspaces keep theirs.
		expect((await track.fileKeys(`${acme}/`)).length).toBeGreaterThan(0);
	});
});
