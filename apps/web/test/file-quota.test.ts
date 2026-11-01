import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// A deployment's quota on attached files (ATTACHMENT_QUOTA_MB): each workspace may keep up to
// that much, and an upload past it is refused before anything is stored. The first copy of the
// Worker has the quota, the second none, and the third a blank value, as a deployment would
// between versions that turn the quota off and on again.

const origin = "https://track.test";
// About 1 KB, so a test can fill it.
const QUOTA_MB = "0.001";
const QUOTA_BYTES = Math.floor(0.001 * 1024 * 1024);

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin, {
		isolates: 3,
		isolateVars: [{ ATTACHMENT_QUOTA_MB: QUOTA_MB }, {}, { ATTACHMENT_QUOTA_MB: "  " }],
	});
});

afterAll(async () => {
	await track?.dispose();
});

async function signUp(name: string, email: string): Promise<string> {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.90", "content-type": "application/json" },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

async function createWorkspace(cookie: string, slug: string): Promise<string> {
	const response = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: {
			origin,
			cookie,
			"cf-connecting-ip": "203.0.113.90",
			"content-type": "application/json",
		},
		body: JSON.stringify({ name: slug, slug }),
	});
	if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
	return ((await response.json()) as { id: string }).id;
}

const WITH_QUOTA = 0;
const WITHOUT_QUOTA = 1;
const BLANK_QUOTA = 2;

function upload(cookie: string, path: string, bytes: number, isolate = WITH_QUOTA) {
	// Each copy answers on its own host, which uploads must come from.
	const from = isolate === 0 ? origin : `https://track-${isolate + 1}.test`;
	return track.fetchIn(isolate, `${origin}${path}`, {
		method: "PUT",
		headers: { origin: from, cookie, "content-type": "application/octet-stream" },
		body: new Uint8Array(bytes),
	});
}

const path = (workspace: string) => `/api/files/${workspace}/${crypto.randomUUID()}/data.bin`;

describe("attachment quota", () => {
	it("refuses an upload past a workspace's quota, and counts each workspace apart", async () => {
		const cookie = await signUp("Quinn", "quinn@quota.test");
		const full = await createWorkspace(cookie, "quota-full");
		const other = await createWorkspace(cookie, "quota-other");

		const first = path(full);
		expect((await upload(cookie, first, 600)).status).toBe(201);
		// A retry of an upload that went through takes no more space.
		expect((await upload(cookie, first, 600)).status).toBe(409);

		const refused = path(full);
		const response = await upload(cookie, refused, 600);
		expect(response.status).toBe(413);
		expect(await response.text()).toContain("full");
		expect(await track.fileKeys(`${full}/${refused.split("/")[4]}/`)).toEqual([]);

		// What is left still fits, to the byte.
		expect((await upload(cookie, path(full), QUOTA_BYTES - 600)).status).toBe(201);
		expect((await upload(cookie, path(full), 1)).status).toBe(413);

		expect((await upload(cookie, path(other), 600)).status).toBe(201);
	});

	it("counts everything uploaded while the quota was off once it is on again", async () => {
		const cookie = await signUp("Olive", "olive@quota.test");
		const workspace = await createWorkspace(cookie, "quota-toggled");

		expect((await upload(cookie, path(workspace), 400)).status).toBe(201);
		// Off: nothing is counted, so the count kept so far no longer says what the bucket holds.
		expect((await upload(cookie, path(workspace), 400, WITHOUT_QUOTA)).status).toBe(201);
		expect((await upload(cookie, path(workspace), 400, WITHOUT_QUOTA)).status).toBe(201);

		// On again: 1,200 bytes are stored, which is past the quota.
		expect((await upload(cookie, path(workspace), 1)).status).toBe(413);
		expect(
			await track.rpc(workspace, "reserveFileStorage", { bytes: 0, limit: QUOTA_BYTES }),
		).toEqual({ ok: false, used: 1200 });
	});

	it("treats a blank quota as none", async () => {
		const cookie = await signUp("Blair", "blair@quota.test");
		const workspace = await createWorkspace(cookie, "quota-blank");
		expect((await upload(cookie, path(workspace), 600, BLANK_QUOTA)).status).toBe(201);
		expect((await upload(cookie, path(workspace), 600, BLANK_QUOTA)).status).toBe(201);
	});
});
