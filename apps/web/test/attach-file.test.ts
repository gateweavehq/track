import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Agents attach files over MCP: `attach_file` hands out an upload address and a token signed with
// the app's secret for a header, and the file gateway takes one upload with no session.
// The file then shows in the issue as people's uploads do.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	// The second copy of the Worker has a quota of about 1 KB a workspace.
	track = await startTrack(origin, {
		isolates: 2,
		isolateVars: [{}, { ATTACHMENT_QUOTA_MB: "0.001" }],
	});
});

afterAll(async () => {
	await track?.dispose();
});

interface Person {
	id: string;
	name: string;
	email: string;
	cookie: string;
}

function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
		},
		body: init.body && JSON.stringify(init.body),
	});
}

async function ok<T>(response: Promise<Response>): Promise<T> {
	const settled = await response;
	if (!settled.ok) throw new Error(`${settled.status} ${await settled.text()}`);
	return (await settled.json()) as T;
}

async function signUp(client: string, name: string, email: string): Promise<Person> {
	const response = await authApi("/sign-up/email", {
		client,
		body: { name, email, password: "a-long-test-password" },
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

async function workspace(client: string, owner: Person, slug: string) {
	const { id } = await ok<{ id: string }>(
		authApi("/organization/create", { client, cookie: owner.cookie, body: { name: slug, slug } }),
	);
	const team = await track.mutate(
		id,
		{ id: owner.id, name: owner.name, email: owner.email, image: null, role: "owner" },
		{ name: "team.create", args: { id: crypto.randomUUID(), key: "ENG", name: "Engineering" } },
	);
	expect(team.ok).toBe(true);
	return id;
}

async function createAgent(client: string, admin: Person, organizationId: string) {
	return ok<{ agent: { id: string }; key: string }>(
		authApi("/agents/create", {
			client,
			cookie: admin.cookie,
			body: { organizationId, name: "Designer" },
		}),
	);
}

async function connect(key: string) {
	const mcp = new Client({ name: "designer", version: "1.0.0" });
	await mcp.connect(
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			fetch: track.fetch,
			requestInit: { headers: { authorization: `Bearer ${key}` } },
		}),
	);
	return mcp;
}

interface Attached {
	name: string;
	type: string;
	size: number;
	uploadUrl: string;
	uploadHeaders: Record<string, string>;
	method: string;
	expiresAt: string;
	attachmentMarkdown: string;
}

async function attach(mcp: Client, slug: string, name: string, type: string, size: number) {
	return mcp.callTool({ name: "attach_file", arguments: { workspace: slug, name, type, size } });
}

async function address(mcp: Client, slug: string, name: string, type: string, size: number) {
	const result = await attach(mcp, slug, name, type, size);
	expect(result.isError).toBeFalsy();
	return result.structuredContent as unknown as Attached;
}

/** A PUT as an agent's shell sends it: no cookie, no Origin. */
function put(url: string, body: BodyInit, headers: Record<string, string> = {}) {
	return track.fetch(url, { method: "PUT", headers, body });
}

function download(path: string, person: Person) {
	return track.fetch(`${origin}${path}`, { headers: { cookie: person.cookie } });
}

/** Signs an upload token as the app does, so tests can make one the tool would not. */
async function signToken(fields: unknown[]): Promise<string> {
	const encoder = new TextEncoder();
	const secret = await crypto.subtle.importKey(
		"raw",
		encoder.encode(track.authSecret),
		"HKDF",
		false,
		["deriveKey"],
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(),
			info: encoder.encode("track-file-upload"),
		},
		secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const payload = base64Url(encoder.encode(JSON.stringify(fields)));
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`track-file-upload:${payload}`));
	return `${payload}.${base64Url(new Uint8Array(mac))}`;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("hex");
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** The fields an address's token carries. */
function fieldsOf(token: string): unknown[] {
	return JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());
}

function uploadHeaders(file: Attached, headers: Record<string, string>) {
	return { ...file.uploadHeaders, ...headers };
}

// The smallest PNG there is: one transparent pixel.
const PIXEL = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	),
	(char) => char.charCodeAt(0),
);
// Not a real video: the gateway stores bytes and serves them by the type it was told.
const CLIP = new Uint8Array(2048).map((_, i) => i % 251);

describe("attaching files over MCP", () => {
	let maya: Person;
	let acme: string;
	let agentKey: string;

	beforeAll(async () => {
		const client = "203.0.113.90";
		maya = await signUp(client, "Maya", "maya@attach.test");
		acme = await workspace(client, maya, "acme-attach");
		await workspace(client, maya, "globex-attach");
		const created = await createAgent(client, maya, acme);
		agentKey = created.key;
	});

	it("lets an agent with only its key attach a PNG and an MP4 that show in an issue", async () => {
		const mcp = await connect(agentKey);
		const issue = await mcp.callTool({
			name: "create_issue",
			arguments: { workspace: "acme-attach", team: "ENG", title: "New landing page" },
		});
		const key = (issue.structuredContent as { key: string }).key;

		const image = await address(mcp, "acme-attach", "hero shot.png", "image/png", PIXEL.length);
		const video = await address(mcp, "acme-attach", "walkthrough.mp4", "video/mp4", CLIP.length);
		expect(image).toMatchObject({ name: "hero shot.png", type: "image/png", method: "PUT" });
		expect(image.uploadUrl).toMatch(
			new RegExp(`^${origin}/api/files/${acme}/[0-9a-f-]{36}/hero%20shot\\.png$`),
		);
		expect(image.uploadHeaders["x-track-upload"]).toBeTruthy();
		// The URL Workers Logs write down does not carry the token.
		expect(image.uploadUrl).not.toContain(image.uploadHeaders["x-track-upload"] ?? "token");
		expect(image.attachmentMarkdown).toMatch(/^!\[hero shot\.png\]\(\/api\/files\//);
		expect(video.attachmentMarkdown).toMatch(/^\[walkthrough\.mp4\]\(\/api\/files\//);
		// About ten minutes.
		const left = Date.parse(image.expiresAt) - Date.now();
		expect(left).toBeGreaterThan(9 * 60 * 1000);
		expect(left).toBeLessThanOrEqual(10 * 60 * 1000);

		expect(
			(await put(image.uploadUrl, PIXEL, uploadHeaders(image, { "content-type": "image/png" })))
				.status,
		).toBe(201);
		expect(
			(await put(video.uploadUrl, CLIP, uploadHeaders(video, { "content-type": "video/mp4" })))
				.status,
		).toBe(201);

		const comment = await mcp.callTool({
			name: "add_comment",
			arguments: {
				workspace: "acme-attach",
				key,
				body: `${image.attachmentMarkdown}\n\n${video.attachmentMarkdown}`,
			},
		});
		expect(comment.isError).toBeFalsy();
		await mcp.close();

		// Members open them as they open people's uploads: the image and the video in place.
		const imagePath = /\((\/api\/files\/[^)]+)\)/.exec(image.attachmentMarkdown)?.[1] ?? "";
		const videoPath = /\((\/api\/files\/[^)]+)\)/.exec(video.attachmentMarkdown)?.[1] ?? "";
		const shown = await download(imagePath, maya);
		expect(shown.status).toBe(200);
		expect(shown.headers.get("content-type")).toBe("image/png");
		expect(shown.headers.get("content-disposition")).toMatch(/^inline; /);
		expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PIXEL);
		const played = await download(videoPath, maya);
		expect(played.headers.get("content-type")).toBe("video/mp4");
		expect(played.headers.get("content-disposition")).toMatch(/^inline; /);
		expect(new Uint8Array(await played.arrayBuffer())).toEqual(CLIP);
		const object = await track.fileKeys(`${acme}/${imagePath.split("/")[4]}/`);
		expect(object).toEqual([`${acme}/${imagePath.split("/")[4]}/hero shot.png`]);
	});

	it("answers a workspace the agent is not in as one that does not exist", async () => {
		const mcp = await connect(agentKey);
		const other = await attach(mcp, "globex-attach", "shot.png", "image/png", 10);
		const missing = await attach(mcp, "nowhere-attach", "shot.png", "image/png", 10);
		await mcp.close();
		expect(other.isError).toBe(true);
		expect(other.content).toEqual([
			{ type: "text", text: 'Workspace "globex-attach" not found. See list_workspaces.' },
		]);
		expect(missing.content).toEqual([
			{ type: "text", text: 'Workspace "nowhere-attach" not found. See list_workspaces.' },
		]);
	});

	it("refuses an altered or expired address, a wrong length and a second upload", async () => {
		const mcp = await connect(agentKey);
		const file = await address(mcp, "acme-attach", "notes.txt", "text/plain", 5);
		await mcp.close();
		const text = { "content-type": "text/plain" };
		const token = file.uploadHeaders["x-track-upload"] ?? "";
		const fields = fieldsOf(token);
		const withToken = (value: string) => ({ ...text, "x-track-upload": value });

		// The payload changed, the signature not: a bigger file than was asked for.
		const [payload = "", signature = ""] = token.split(".");
		const bigger = base64Url(
			new TextEncoder().encode(JSON.stringify(fields.map((value, i) => (i === 4 ? 6 : value)))),
		);
		expect((await put(file.uploadUrl, "hello!", withToken(`${bigger}.${signature}`))).status).toBe(
			403,
		);
		expect(
			(await put(file.uploadUrl, "hello", withToken(`${payload}.${"A".repeat(43)}`))).status,
		).toBe(403);
		expect((await put(file.uploadUrl, "hello", withToken(""))).status).toBe(403);
		// Signed by the secret but past its time.
		const past = fields.map((value, i) => (i === 6 ? Math.floor(Date.now() / 1000) - 1 : value));
		expect((await put(file.uploadUrl, "hello", withToken(await signToken(past)))).status).toBe(403);
		// Another file's path under a valid token.
		const elsewhere = file.uploadUrl.replace("/notes.txt", "/other.txt");
		expect((await put(elsewhere, "hello", uploadHeaders(file, text))).status).toBe(403);

		// The length is the size the agent named.
		expect((await put(file.uploadUrl, "hello!", uploadHeaders(file, text))).status).toBe(400);
		expect((await put(file.uploadUrl, "hell", uploadHeaders(file, text))).status).toBe(400);
		// The same fields signed here are taken, so it was the expiry that refused the one above.
		expect((await put(file.uploadUrl, "hello", withToken(await signToken(fields)))).status).toBe(
			201,
		);
		// Once stored, it stays: the address answers as a retry by the one who stored it.
		expect((await put(file.uploadUrl, "hullo", uploadHeaders(file, text))).status).toBe(409);
		const path = new URL(file.uploadUrl).pathname;
		expect(await (await download(path, maya)).text()).toBe("hello");
	});

	it("refuses the upload of a member removed after asking, as if there were no workspace", async () => {
		const client = "203.0.113.91";
		const owner = await signUp(client, "Wes", "wes@attach.test");
		const initech = await workspace(client, owner, "initech-attach");
		const { key, agent } = await createAgent(client, owner, initech);
		const mcp = await connect(key);
		const file = await address(mcp, "initech-attach", "shot.png", "image/png", PIXEL.length);
		await mcp.close();

		await track.db
			.prepare("DELETE FROM member WHERE organization_id = ? AND user_id = ?")
			.bind(initech, agent.id)
			.run();
		const refused = await put(
			file.uploadUrl,
			PIXEL,
			uploadHeaders(file, { "content-type": "image/png" }),
		);
		expect(refused.status).toBe(404);
		expect(await refused.json()).toEqual({ error: "Not found" });
		expect(await track.fileKeys(`${initech}/`)).toEqual([]);
	});

	it("refuses the upload of a key revoked after asking, as if there were no workspace", async () => {
		const client = "203.0.113.92";
		const owner = await signUp(client, "Ines", "ines@attach.test");
		const hooli = await workspace(client, owner, "hooli-attach");
		const { key, agent } = await createAgent(client, owner, hooli);
		// A second key of the same agent: revoking one leaves the other's addresses working.
		const other = await ok<{ key: { id: string }; secret: string }>(
			authApi("/agents/create-key", { client, cookie: owner.cookie, body: { agentId: agent.id } }),
		);
		const keyId = async (secret: string) => {
			const row = await track.db
				.prepare("SELECT id FROM agent_key WHERE hash = ?")
				.bind(await sha256(secret))
				.first<{ id: string }>();
			return row?.id ?? "";
		};
		const mcp = await connect(key);
		const revoked = await address(mcp, "hooli-attach", "shot.png", "image/png", PIXEL.length);
		await mcp.close();
		const mcpOther = await connect(other.secret);
		const kept = await address(mcpOther, "hooli-attach", "shot.png", "image/png", PIXEL.length);
		await mcpOther.close();

		await ok(
			authApi("/agents/revoke-key", {
				client,
				cookie: owner.cookie,
				body: { keyId: await keyId(key) },
			}),
		);
		const refused = await put(
			revoked.uploadUrl,
			PIXEL,
			uploadHeaders(revoked, { "content-type": "image/png" }),
		);
		expect(refused.status).toBe(404);
		expect(await refused.json()).toEqual({ error: "Not found" });
		expect(
			await track.fileKeys(`${hooli}/${new URL(revoked.uploadUrl).pathname.split("/")[4]}/`),
		).toEqual([]);
		expect(
			(await put(kept.uploadUrl, PIXEL, uploadHeaders(kept, { "content-type": "image/png" })))
				.status,
		).toBe(201);
	});

	it("holds an address's upload to the size limit and the workspace's quota", async () => {
		const mcp = await connect(agentKey);
		const file = await address(mcp, "acme-attach", "big.bin", "application/octet-stream", 2000);
		await mcp.close();
		const binary = { "content-type": "application/octet-stream" };

		// Past the quota of the copy that has one.
		const full = await track.fetchIn(1, file.uploadUrl, {
			method: "PUT",
			headers: uploadHeaders(file, binary),
			body: new Uint8Array(2000),
		});
		expect(full.status).toBe(413);
		expect(await full.json()).toEqual({
			error: "This workspace's files are full. Whoever runs this Track can raise its limit",
		});

		// The tool never signs a size over the limit, and the gateway would not take one anyway.
		const size = 25 * 1024 * 1024 + 1;
		const token = file.uploadHeaders["x-track-upload"] ?? "";
		const fields = fieldsOf(token).map((value, i) => (i === 4 ? size : value));
		const url = new URL(file.uploadUrl);
		const answer = await put(
			file.uploadUrl,
			new Uint8Array(size),
			uploadHeaders(file, { ...binary, "x-track-upload": await signToken(fields) }),
		).then(
			async (response) => (await response.json()) as unknown,
			(error: unknown) =>
				String(error).includes("fetch failed") ? "closed" : Promise.reject(error),
		);
		expect([{ error: "Files can be up to 25 MB" }, "closed"]).toContainEqual(answer);
		expect(await track.fileKeys(`${acme}/${url.pathname.split("/")[4]}/`)).toEqual([]);
	});

	it("keeps a session's upload as it was, and never takes a token from a cookie", async () => {
		const mcp = await connect(agentKey);
		const file = await address(mcp, "acme-attach", "shot.png", "image/png", PIXEL.length);
		await mcp.close();
		const png = { "content-type": "image/png" };
		const sessionPath = `/api/files/${acme}/${crypto.randomUUID()}/screenshot.png`;

		// A member's browser uploads as before, from the app's origin only.
		expect(
			(await put(`${origin}${sessionPath}`, PIXEL, { ...png, cookie: maya.cookie, origin })).status,
		).toBe(201);
		expect(
			(
				await put(`${origin}/api/files/${acme}/${crypto.randomUUID()}/a.png`, PIXEL, {
					...png,
					cookie: maya.cookie,
					origin: "https://evil.test",
				})
			).status,
		).toBe(403);
		expect(
			(
				await put(`${origin}/api/files/${acme}/${crypto.randomUUID()}/a.png`, PIXEL, {
					...png,
					origin,
				})
			).status,
		).toBe(401);

		// A token in a cookie is no token, and a session does not stand in for a failed one.
		const token = file.uploadHeaders["x-track-upload"] ?? "";
		const bare = file.uploadUrl;
		expect((await put(bare, PIXEL, { ...png, cookie: `upload=${token}`, origin })).status).toBe(
			401,
		);
		expect(
			(await put(`${bare}?upload=forged`, PIXEL, { ...png, cookie: maya.cookie, origin })).status,
		).toBe(403);
		// The file is stored under the agent who asked, so a member's browser cannot take it over.
		expect((await put(file.uploadUrl, PIXEL, uploadHeaders(file, png))).status).toBe(201);
		expect((await put(bare, PIXEL, { ...png, cookie: maya.cookie, origin })).status).toBe(412);
	});
});
