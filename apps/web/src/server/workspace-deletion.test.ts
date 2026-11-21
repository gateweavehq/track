import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, type Database, schema } from "./db";
import { finishWorkspaceDeletion, retryWorkspaceDeletions } from "./workspace-deletion";

// Real D1 queries, with stand-ins for the objects and the bucket: local workerd has no
// jurisdictions, and these tests are about what fails and what is tried again.
const { env, destroy, listFiles, deleteFiles } = vi.hoisted(() => {
	const destroy = vi.fn<(jurisdiction: string, workspaceId: string) => Promise<void>>();
	const listFiles =
		vi.fn<(options: { prefix: string }) => Promise<{ objects: { key: string }[] }>>();
	const deleteFiles = vi.fn<(keys: string[]) => Promise<void>>();
	function namespace(jurisdiction: string) {
		return { getByName: (id: string) => ({ destroy: () => destroy(jurisdiction, id) }) };
	}
	const env = {
		WORKSPACE: { ...namespace(""), jurisdiction: namespace },
		FILES: { list: listFiles, delete: deleteFiles },
	};
	return { env, destroy, listFiles, deleteFiles };
});
vi.mock("cloudflare:workers", () => ({ env }));

const { workspaceDeletion, workspaceLocation, organization } = schema;
let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "workspace-deletion-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

beforeEach(async () => {
	vi.resetAllMocks();
	destroy.mockResolvedValue(undefined);
	listFiles.mockResolvedValue({ objects: [] });
	deleteFiles.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	await db.delete(workspaceDeletion).run();
	await db.delete(workspaceLocation).run();
	await db.delete(organization).run();
});

const note = (workspaceId: string) =>
	db.select().from(workspaceDeletion).where(eq(workspaceDeletion.workspaceId, workspaceId)).get();
const location = (workspaceId: string) =>
	db.select().from(workspaceLocation).where(eq(workspaceLocation.workspaceId, workspaceId)).get();

async function noted(workspaceId: string, deletedAt = 1, lastTriedAt: number | null = null) {
	await db.insert(workspaceDeletion).values({ workspaceId, deletedAt, lastTriedAt }).run();
}

async function workspace(id: string) {
	await db
		.insert(organization)
		.values({ id, name: id, slug: id, createdAt: new Date(0) })
		.run();
}

it("finishes a deletion that failed on the next daily run, old copy and files too", async () => {
	await db
		.insert(workspaceLocation)
		.values({ workspaceId: "doomed", jurisdiction: "eu", movedFrom: "", movedAt: 1 })
		.run();
	await noted("doomed");
	listFiles.mockResolvedValue({ objects: [{ key: "doomed/a/one.txt" }] });
	destroy.mockRejectedValueOnce(new Error("unreachable"));

	await expect(finishWorkspaceDeletion(db, "doomed")).rejects.toThrow("unreachable");
	// Both rows stay, so the retry still knows where the objects are.
	expect((await note("doomed"))?.lastTriedAt).toEqual(expect.any(Number));
	expect(await location("doomed")).toMatchObject({ jurisdiction: "eu", movedFrom: "" });

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls).toEqual([
		["eu", "doomed"],
		["eu", "doomed"],
		["", "doomed"],
	]);
	expect(deleteFiles).toHaveBeenCalledWith(["doomed/a/one.txt"]);
	expect(await note("doomed")).toBeUndefined();
	expect(await location("doomed")).toBeUndefined();
});

it("keeps the note when the files fail, and tries the whole deletion again", async () => {
	await noted("files-fail");
	listFiles.mockRejectedValueOnce(new Error("bucket down"));

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls).toEqual([["", "files-fail"]]);
	expect((await note("files-fail"))?.lastTriedAt).toEqual(expect.any(Number));

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls).toHaveLength(2);
	expect(await note("files-fail")).toBeUndefined();
});

it("takes a location row whose workspace is gone as a deletion, and leaves the others", async () => {
	await workspace("kept");
	await db
		.insert(workspaceLocation)
		.values([
			{ workspaceId: "kept", jurisdiction: "eu" },
			{ workspaceId: "orphan", jurisdiction: "eu" },
		])
		.run();

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls).toEqual([["eu", "orphan"]]);
	expect(await location("orphan")).toBeUndefined();
	expect(await location("kept")).toMatchObject({ jurisdiction: "eu" });
	expect(await note("orphan")).toBeUndefined();
	expect(await note("kept")).toBeUndefined();
});

it("never destroys a workspace that is still there, and drops the note that says otherwise", async () => {
	await workspace("alive");
	await noted("alive");

	await retryWorkspaceDeletions(db);
	expect(destroy).not.toHaveBeenCalled();
	expect(listFiles).not.toHaveBeenCalled();
	expect(await note("alive")).toBeUndefined();

	await noted("alive");
	await expect(finishWorkspaceDeletion(db, "alive")).rejects.toThrow("still there");
	expect(destroy).not.toHaveBeenCalled();
	expect(await note("alive")).toBeUndefined();
});

it("keeps the note when a move notes another place while the objects go", async () => {
	await db.insert(workspaceLocation).values({ workspaceId: "racing", jurisdiction: "eu" }).run();
	await noted("racing");
	await noted("racing-out");
	// A move copied each into "us" before the deletion, one from "eu" and one from outside any, and
	// records that once their objects are gone.
	destroy.mockImplementation(async (jurisdiction, id) => {
		if (destroy.mock.calls.length > 2) return;
		const moved = { jurisdiction: "us", movedFrom: jurisdiction, movedAt: 2 };
		await db
			.insert(workspaceLocation)
			.values({ workspaceId: id, ...moved })
			.onConflictDoUpdate({ target: workspaceLocation.workspaceId, set: moved })
			.run();
	});

	await finishWorkspaceDeletion(db, "racing");
	await finishWorkspaceDeletion(db, "racing-out");
	expect(destroy.mock.calls).toEqual([
		["eu", "racing"],
		["", "racing-out"],
	]);
	for (const id of ["racing", "racing-out"]) {
		expect(await location(id)).toMatchObject({ jurisdiction: "us" });
		expect(await note(id)).toBeDefined();
	}

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls.slice(2)).toEqual([
		["us", "racing"],
		["eu", "racing"],
		["us", "racing-out"],
		["", "racing-out"],
	]);
	for (const id of ["racing", "racing-out"]) {
		expect(await location(id)).toBeUndefined();
		expect(await note(id)).toBeUndefined();
	}
});

it("finishes two a run, those never tried first, and the rest on the next", async () => {
	await noted("tried-before", 1, 5);
	await noted("first", 1);
	await noted("second", 2);
	await noted("third", 3);

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls.map(([, id]) => id)).toEqual(["first", "second"]);

	await retryWorkspaceDeletions(db);
	expect(destroy.mock.calls.map(([, id]) => id)).toEqual([
		"first",
		"second",
		"third",
		"tried-before",
	]);
	expect(await note("tried-before")).toBeUndefined();
});
