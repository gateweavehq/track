import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database, schema } from "../db";
import { createAuth } from "./config";

// Deleting an account takes its memberships with it by cascade, so no organization hook runs.
// The app does not offer account deletion over HTTP, so this drives Better Auth's own deletion,
// which every path to it shares, against a real D1 database (TRK-66).

let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-config-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	// Miniflare's D1 type is its own; it is the same binding a Worker gets.
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

describe("Better Auth's hooks", () => {
	it("tells each of a deleted user's workspaces, once their membership is gone", async () => {
		const now = new Date();
		await db.insert(schema.user).values({ id: "u-dana", name: "Dana", email: "dana@example.com" });
		for (const id of ["w-acme", "w-initech"]) {
			await db.insert(schema.organization).values({ id, name: id, slug: id, createdAt: now });
			await db.insert(schema.member).values({
				id: `m-${id}`,
				organizationId: id,
				userId: "u-dana",
				role: "member",
				createdAt: now,
			});
		}
		const told: { workspaceId: string; userId: string; stillMember: boolean }[] = [];
		const auth = createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "http://localhost:4710",
			onMembershipChange: async (workspaceId, userId) => {
				const row = await db
					.select()
					.from(schema.member)
					.where(eq(schema.member.organizationId, workspaceId))
					.get();
				told.push({ workspaceId, userId, stillMember: row !== undefined });
			},
		});

		await (await auth.$context).internalAdapter.deleteUser("u-dana");

		expect(told.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
			{ workspaceId: "w-acme", userId: "u-dana", stillMember: false },
			{ workspaceId: "w-initech", userId: "u-dana", stillMember: false },
		]);
	});
});
