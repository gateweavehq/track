import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import { readRolledBack } from "../src/backup";
import { freshWorkspace } from "./client";

// Gateweave Backup reads a workspace's SQLite through `backupRead`: the SELECTs of its dump, run
// together and rolled back, so a backup sees one moment and can never change the workspace.

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};

async function workspaceWithTeam() {
	const workspace = freshWorkspace();
	await workspace.syncMember(owner);
	const result = await workspace.mutate(owner, "client", "m-1", {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
	expect(result.ok).toBe(true);
	return workspace;
}

/** How a call failed: its error's message, or null if it didn't. */
async function failure(call: Promise<unknown>): Promise<string | null> {
	return call.then(
		() => null,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

describe("reads for a backup", () => {
	it("return each statement's rows, as one moment", async () => {
		const workspace = await workspaceWithTeam();
		const [schema, tables, teams, columns] = await workspace.backupRead([
			"SELECT type, name FROM sqlite_master WHERE name = 'teams'",
			"PRAGMA table_list",
			"SELECT quote(id) || ',' || quote(key) AS v FROM teams",
			"PRAGMA table_info(teams)",
		]);
		expect(schema).toEqual([{ type: "table", name: "teams" }]);
		expect(tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "teams" })]));
		expect(teams).toEqual([{ v: "'team-eng','ENG'" }]);
		expect(columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: "key" })]));
	});

	it("refuse anything but a read, and more than one statement at a time", async () => {
		const workspace = await workspaceWithTeam();
		const refused = [
			["DELETE FROM teams"],
			["UPDATE teams SET name = 'x'"],
			["SELECT 1; DELETE FROM teams"],
			["PRAGMA foreign_keys = off"],
			["WITH t AS (SELECT 1) DELETE FROM teams"],
			[],
		];
		for (const statements of refused) {
			expect(await failure(workspace.backupRead(statements)), JSON.stringify(statements)).toMatch(
				/^The workspace refused the backup's read\. (A backup only reads|One statement at a time|Too small)/,
			);
		}
		const [teams] = await workspace.backupRead(["SELECT name FROM teams"]);
		expect(teams).toEqual([{ name: "Engineering" }]);
	});

	it("roll back whatever they ran, even a write that got past the check", async () => {
		const workspace = await workspaceWithTeam();
		const rows = await runInDurableObject(workspace, (_, state) =>
			readRolledBack(state.storage, [
				"UPDATE teams SET name = 'Changed'",
				"SELECT name FROM teams",
			]),
		);
		// Inside the transaction the write showed; after it, it is gone.
		expect(rows[1]).toEqual([{ name: "Changed" }]);
		const [teams] = await workspace.backupRead(["SELECT name FROM teams"]);
		expect(teams).toEqual([{ name: "Engineering" }]);
	});

	it("pass on an error SQLite gives, and leave the workspace as it was", async () => {
		const workspace = await workspaceWithTeam();
		expect(await failure(workspace.backupRead(["SELECT * FROM no_such_table"]))).toMatch(
			/no such table/,
		);
		const [teams] = await workspace.backupRead(["SELECT key FROM teams"]);
		expect(teams).toEqual([{ key: "ENG" }]);
	});
});
