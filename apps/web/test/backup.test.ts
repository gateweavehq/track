import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Gateweave Backup reaches the app through its named Backup entrypoint, from a Worker with a
// service binding to it: it lists the workspaces, then reads each one's Durable Object with the
// SELECTs of a SQLite dump, which the object rolls back.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

async function signUp(client: string, name: string, email: string) {
	const response = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ name, email, password: "a-long-test-password" }),
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, cookie };
}

async function createWorkspace(client: string, slug: string) {
	const owner = await signUp(client, "Bea Backup", `${slug}@backup.test`);
	const created = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			cookie: owner.cookie,
		},
		body: JSON.stringify({ name: slug, slug }),
	});
	expect(created.status).toBe(200);
	const { id } = (await created.json()) as { id: string };
	const snapshot = await track.fetch(`${origin}/api/sync/${slug}/snapshot`, {
		headers: { cookie: owner.cookie },
	});
	expect(snapshot.status).toBe(200);
	const member = { id: owner.id, name: owner.name, email: owner.email, image: null, role: "owner" };
	const mutate = (name: string, args: object) => track.mutate(id, member, { name, args });
	expect(await mutate("team.create", { id: "team-ops", key: "OPS", name: "Operations" })).toEqual(
		expect.objectContaining({ ok: true }),
	);
	return { id, mutate };
}

describe("the Backup entrypoint", () => {
	it("lists the workspaces and reads one's object, rolled back", async () => {
		const workspace = await createWorkspace("203.0.113.170", "backed-up");
		await workspace.mutate("issue.create", {
			id: "issue-kept",
			teamId: "team-ops",
			title: "Kept in the backup",
			status: "todo",
			sortOrder: "a0",
		});

		const listed = await track.backup<{ names: string[]; cursor?: string }>("objects");
		expect(listed.result?.names).toContain(workspace.id);

		const read = await track.backup<unknown[][]>("read", workspace.id, [
			"SELECT type, name FROM sqlite_master WHERE name = 'issues'",
			"SELECT quote(id) || ',' || quote(title) AS v FROM issues",
		]);
		expect(read).toEqual({
			result: [[{ type: "table", name: "issues" }], [{ v: "'issue-kept','Kept in the backup'" }]],
		});
	});

	it("refuses a write, and a name that isn't a workspace", async () => {
		const workspace = await createWorkspace("203.0.113.171", "read-only");
		const write = await track.backup("read", workspace.id, ["DELETE FROM teams"]);
		expect(write.error).toMatch(/^The workspace refused the backup's read\. A backup only reads/);
		const teams = await track.backup<unknown[][]>("read", workspace.id, ["SELECT key FROM teams"]);
		expect(teams.result).toEqual([[{ key: "OPS" }]]);

		const stranger = crypto.randomUUID();
		const missing = await track.backup("read", stranger, ["SELECT 1 AS one"]);
		expect(missing.error).toBe("There is no workspace of that name.");
	});

	it("pages through the workspaces in order", async () => {
		const ids = Array.from({ length: 120 }, (_, i) => `paged-${String(i).padStart(3, "0")}`);
		await track.db.batch(
			ids.map((id) =>
				track.db
					.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)")
					.bind(id, id, id),
			),
		);
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await track.backup<{ names: string[]; cursor?: string }>(
				"objects",
				...(cursor === undefined ? [] : [cursor]),
			);
			if (!page.result) throw new Error(page.error);
			expect(page.result.names.length).toBeLessThanOrEqual(100);
			seen.push(...page.result.names);
			cursor = page.result.cursor;
			pages++;
		} while (cursor !== undefined);
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual([...seen].sort());
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual(expect.arrayContaining(ids));
	});
});
