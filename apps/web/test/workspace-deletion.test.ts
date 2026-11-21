import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

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

async function notes(workspaceId: string): Promise<number> {
	const row = await track.db
		.prepare("SELECT count(*) AS n FROM workspace_deletion WHERE workspace_id = ?")
		.bind(workspaceId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("deleting a workspace", () => {
	it("empties its object and keeps no note once it is done", async () => {
		const client = "203.0.113.91";
		const owner = await signUp(client, "Dee", "dee@deletion.test");
		const workspaceId = await createWorkspace(client, owner, "gone-at-once");
		expect((await track.directory(workspaceId)).members).toHaveLength(1);

		const deleted = await track.fetch(`${origin}/api/auth/organization/delete`, {
			method: "POST",
			headers: {
				origin,
				cookie: owner.cookie,
				"cf-connecting-ip": client,
				"content-type": "application/json",
			},
			body: JSON.stringify({ organizationId: workspaceId }),
		});
		expect(deleted.status).toBe(200);
		// The object and the files go after the response, and the note with them.
		await vi.waitFor(async () => {
			expect((await track.directory(workspaceId)).members).toEqual([]);
			expect(await notes(workspaceId)).toBe(0);
		});
	});

	it("finishes on the daily run a deletion whose object the request couldn't reach", async () => {
		const client = "203.0.113.92";
		const owner = await signUp(client, "Hal", "hal@deletion.test");
		const workspaceId = await createWorkspace(client, owner, "half-gone");
		// What a failed request leaves: the row and its members gone with the note written in the
		// same batch, and the object, with everything in it, still there.
		await track.db.batch([
			track.db
				.prepare("INSERT INTO workspace_deletion (workspace_id, deleted_at) VALUES (?1, ?2)")
				.bind(workspaceId, Date.now()),
			track.db.prepare("DELETE FROM organization WHERE id = ?1").bind(workspaceId),
		]);
		expect((await track.directory(workspaceId)).members).toHaveLength(1);

		await track.runScheduled();
		expect((await track.directory(workspaceId)).members).toEqual([]);
		expect(await notes(workspaceId)).toBe(0);
	});
});
