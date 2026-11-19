import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, type Database, schema } from "./db";
import { moveWorkspaces } from "./move";
import { destroyWorkspace } from "./workspaces";

// Use real D1 queries and stand-in namespaces, since local workerd has no jurisdictions.
const { env, moveForget, destroy, moveWorkspace } = vi.hoisted(() => {
	const moveForget = vi.fn<(jurisdiction: string, workspaceId: string) => Promise<void>>();
	const destroy = vi.fn<(jurisdiction: string, workspaceId: string) => Promise<void>>();
	const moveWorkspace = vi.fn();
	function namespace(jurisdiction: string) {
		return {
			getByName: (id: string) => ({
				moveForget: () => moveForget(jurisdiction, id),
				destroy: () => destroy(jurisdiction, id),
			}),
		};
	}
	const env = {
		WORKSPACE: { ...namespace(""), jurisdiction: namespace },
		DURABLE_OBJECT_JURISDICTION: undefined as string | undefined,
	};
	return { env, moveForget, destroy, moveWorkspace };
});
vi.mock("cloudflare:workers", () => ({ env }));
vi.mock("@gateweave/track-sync-server", () => ({ moveWorkspace }));

const location = schema.workspaceLocation;
const DAY = 24 * 60 * 60 * 1000;
let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "move-test" },
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
	env.DURABLE_OBJECT_JURISDICTION = undefined;
	await db.delete(location).run();
	await db.delete(schema.organization).run();
});

async function moved(workspaceId: string, daysAgo: number, movedFrom = "") {
	await db
		.insert(location)
		.values({
			workspaceId,
			jurisdiction: "eu",
			movedFrom,
			movedAt: Date.now() - daysAgo * DAY,
		})
		.run();
}

function where(workspaceId: string) {
	return db.select().from(location).where(eq(location.workspaceId, workspaceId)).get();
}

it("forgets an eight-day-old copy even with no configured jurisdiction", async () => {
	await moved("old", 8);

	await moveWorkspaces(db);
	await moveWorkspaces(db);

	expect(moveForget.mock.calls).toEqual([["", "old"]]);
	expect(await where("old")).toMatchObject({ jurisdiction: "eu", movedFrom: null });
});

it("leaves a six-day-old copy alone", async () => {
	await moved("young", 6, "us");

	await moveWorkspaces(db);

	expect(moveForget).not.toHaveBeenCalled();
	expect(await where("young")).toMatchObject({ movedFrom: "us" });
});

it("keeps the pointer on failure, continues with other copies and retries on the next run", async () => {
	await moved("failed", 9, "us");
	await moved("next", 8);
	let failures = 0;
	moveForget.mockImplementation(async (_jurisdiction, id) => {
		if (id === "failed" && failures++ === 0) throw new Error("Unavailable");
	});
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await moveWorkspaces(db);

		expect(logged).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.any(Error));
		expect(await where("failed")).toMatchObject({ movedFrom: "us" });
		expect(await where("next")).toMatchObject({ movedFrom: null });
		expect(moveForget.mock.calls).toHaveLength(2);
		expect(moveForget.mock.calls).toEqual(
			expect.arrayContaining([
				["us", "failed"],
				["", "next"],
			]),
		);

		await moveWorkspaces(db);
		expect(moveForget.mock.calls).toHaveLength(3);
		expect(moveForget).toHaveBeenLastCalledWith("us", "failed");
		expect(await where("failed")).toMatchObject({ movedFrom: null });
	} finally {
		logged.mockRestore();
	}
});

it("destroys only the current object when deleting a workspace after forgetting its old copy", async () => {
	await moved("deleted", 8);
	await moveWorkspaces(db);

	await destroyWorkspace(db, "deleted");

	expect(destroy.mock.calls).toEqual([["eu", "deleted"]]);
	expect(await where("deleted")).toBeUndefined();
});

it("logs and skips an old-copy pointer to the current jurisdiction", async () => {
	await moved("same", 8, "eu");
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await moveWorkspaces(db);

		expect(moveForget).not.toHaveBeenCalled();
		expect(logged).toHaveBeenCalledWith(expect.stringContaining("current jurisdiction"));
		expect(await where("same")).toMatchObject({ movedFrom: "eu" });
	} finally {
		logged.mockRestore();
	}
});

it("forgets at most three copies per run, the rest on the next, including one exactly a week old", async () => {
	const ids = ["week", "eighth", "ninth", "tenth"];
	await moved("week", 7);
	await moved("eighth", 8);
	await moved("ninth", 9);
	await moved("tenth", 10);

	await moveWorkspaces(db);
	expect(moveForget).toHaveBeenCalledTimes(3);
	const first = moveForget.mock.calls.map(([, id]) => id);
	expect(new Set(first).size).toBe(3);

	await moveWorkspaces(db);
	expect(moveForget).toHaveBeenCalledTimes(4);
	expect(moveForget.mock.calls.map(([, id]) => id).sort()).toEqual([...ids].sort());
	for (const id of ids) expect(await where(id)).toMatchObject({ movedFrom: null });
});

it("doesn't let copies that keep failing hold up the others", async () => {
	// Three copies older than the one that can go, each failing on every run: in a fixed oldest-first
	// order they would take all three places in every run.
	await moved("stuck-1", 12, "us");
	await moved("stuck-2", 11, "us");
	await moved("stuck-3", 10, "us");
	await moved("fine", 8);
	moveForget.mockImplementation(async (_jurisdiction, id) => {
		if (id.startsWith("stuck")) throw new Error("Only a sealed workspace copy can be forgotten.");
	});
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		// The chance that "fine" is left out of 30 random draws of three from four is 4^-30.
		for (let run = 0; run < 30 && (await where("fine"))?.movedFrom !== null; run++) {
			await moveWorkspaces(db);
		}
		expect(await where("fine")).toMatchObject({ movedFrom: null });
		expect(await where("stuck-1")).toMatchObject({ movedFrom: "us" });
	} finally {
		logged.mockRestore();
	}
});

it("retains the old copy's location when the deployment changes jurisdictions again", async () => {
	env.DURABLE_OBJECT_JURISDICTION = "us";
	await db
		.insert(schema.organization)
		.values({
			id: "again",
			name: "Again",
			slug: "again",
			createdAt: new Date(),
		})
		.run();
	await moved("again", 6);

	await moveWorkspaces(db);

	expect(moveWorkspace).not.toHaveBeenCalled();
	expect(await where("again")).toMatchObject({ jurisdiction: "eu", movedFrom: "" });
});
