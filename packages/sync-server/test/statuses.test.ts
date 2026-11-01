import { runInDurableObject } from "cloudflare:test";
import {
	DEFAULT_STATUSES,
	MAX_STATUSES_PER_TEAM,
	type MutationInput,
	statusId,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
const TEAM_ID = "team-eng";

async function workspaceWithTeam() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, triage]) await workspace.syncMember(member);
	let n = 0;
	const attempt = (member: MemberProfile, mutation: MutationInput) =>
		workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await attempt(member, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	return { workspace, as, attempt };
}

function createStatus(
	args: Partial<Extract<MutationInput, { name: "status.create" }>["args"]> = {},
): MutationInput {
	return {
		name: "status.create",
		args: {
			teamId: TEAM_ID,
			key: "qa",
			name: "QA",
			category: "started",
			color: "#0ea5e9",
			sortOrder: "a2",
			...args,
		},
	};
}

function createIssue(id: string, status?: string): MutationInput {
	return {
		name: "issue.create",
		args: { id, teamId: TEAM_ID, title: id, sortOrder: "a0", ...(status && { status }) },
	};
}

async function statusesOf(workspace: Workspace): Promise<WorkflowStatus[]> {
	return (await workspace.snapshot(owner)).statuses.filter((status) => status.teamId === TEAM_ID);
}

async function issueOf(workspace: Workspace, id: string) {
	const issue = (await workspace.snapshot(owner)).issues.find((issue) => issue.id === id);
	if (!issue) throw new Error(`No issue ${id}`);
	return issue;
}

describe("statuses", () => {
	it("start as the six every team had, for every new team", async () => {
		const { workspace } = await workspaceWithTeam();
		expect(await statusesOf(workspace)).toEqual(
			DEFAULT_STATUSES.map((status) =>
				expect.objectContaining({
					...status,
					id: statusId(TEAM_ID, status.key),
					teamId: TEAM_ID,
					removedAt: null,
				}),
			),
		);
	});

	it("are added by admins, with a key and a name of their own in the team", async () => {
		const { workspace, as, attempt } = await workspaceWithTeam();
		expect(await attempt(alice, createStatus())).toMatchObject({ ok: false, reason: "forbidden" });

		await as(owner, createStatus());
		expect(await statusesOf(workspace)).toContainEqual(
			expect.objectContaining({ id: `${TEAM_ID}/qa`, key: "qa", name: "QA", category: "started" }),
		);
		expect(await attempt(owner, createStatus({ name: "Testing" }))).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		expect(await attempt(owner, createStatus({ key: "qa_2", name: "qa" }))).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		expect(await attempt(owner, createStatus({ teamId: "team-nope" }))).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it(`are at most ${MAX_STATUSES_PER_TEAM} in a team`, async () => {
		const { as, attempt } = await workspaceWithTeam();
		for (let n = DEFAULT_STATUSES.length; n < MAX_STATUSES_PER_TEAM; n++) {
			await as(owner, createStatus({ key: `s${n}`, name: `S${n}` }));
		}
		expect(await attempt(owner, createStatus())).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("are what an issue's status can be, the team's first when it names none", async () => {
		const { workspace, as, attempt } = await workspaceWithTeam();
		await as(owner, createStatus());
		await as(alice, createIssue("issue-1"));
		expect((await issueOf(workspace, "issue-1")).status).toBe("backlog");

		await as(alice, createIssue("issue-2", "qa"));
		expect((await issueOf(workspace, "issue-2")).status).toBe("qa");
		expect(await attempt(alice, createIssue("issue-3", "shipped"))).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		const issue = await issueOf(workspace, "issue-1");
		expect(
			await attempt(alice, {
				name: "issue.update",
				args: { id: issue.id, baseVersion: issue.version, patch: { status: "shipped" } },
			}),
		).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("are renamed and moved without changing their key", async () => {
		const { workspace, as, attempt } = await workspaceWithTeam();
		await as(alice, createIssue("issue-1", "in_review"));
		await as(owner, {
			name: "status.update",
			args: { teamId: TEAM_ID, key: "in_review", patch: { name: "Code review", sortOrder: "Zz" } },
		});
		expect(await statusesOf(workspace)).toContainEqual(
			expect.objectContaining({ key: "in_review", name: "Code review", sortOrder: "Zz" }),
		);
		expect((await issueOf(workspace, "issue-1")).status).toBe("in_review");
		expect(
			await attempt(owner, {
				name: "status.update",
				args: { teamId: TEAM_ID, key: "todo", patch: { name: "code REVIEW" } },
			}),
		).toMatchObject({ ok: false, reason: "conflict" });
		expect(
			await attempt(alice, {
				name: "status.update",
				args: { teamId: TEAM_ID, key: "todo", patch: { name: "Ready" } },
			}),
		).toMatchObject({ ok: false, reason: "forbidden" });
	});

	it("keep a completed one in every team", async () => {
		const { as, attempt } = await workspaceWithTeam();
		const toStarted = {
			name: "status.update",
			args: { teamId: TEAM_ID, key: "done", patch: { category: "started" } },
		} satisfies MutationInput;
		expect(await attempt(owner, toStarted)).toMatchObject({ ok: false, reason: "invalid" });
		expect(
			await attempt(owner, {
				name: "status.delete",
				args: { teamId: TEAM_ID, key: "done", moveTo: "canceled" },
			}),
		).toMatchObject({ ok: false, reason: "invalid" });

		await as(owner, createStatus({ key: "shipped", name: "Shipped", category: "completed" }));
		await as(owner, toStarted);
	});

	it("move their issues when removed, in history and without telling inboxes", async () => {
		const { workspace, as, attempt } = await workspaceWithTeam();
		await as(owner, createStatus());
		await as(owner, createIssue("issue-1", "qa"));
		await as(owner, createIssue("issue-2", "qa"));
		await as(owner, { name: "issue.delete", args: { id: "issue-2" } });
		await as(owner, createIssue("issue-3", "todo"));
		await as(alice, { name: "issue.subscribe", args: { issueId: "issue-1", subscribed: true } });

		expect(
			await attempt(owner, {
				name: "status.delete",
				args: { teamId: TEAM_ID, key: "qa", moveTo: "qa" },
			}),
		).toMatchObject({ ok: false, reason: "invalid" });
		expect(
			await attempt(owner, {
				name: "status.delete",
				args: { teamId: TEAM_ID, key: "qa", moveTo: "shipped" },
			}),
		).toMatchObject({ ok: false, reason: "invalid" });
		expect(
			await attempt(alice, {
				name: "status.delete",
				args: { teamId: TEAM_ID, key: "qa", moveTo: "in_review" },
			}),
		).toMatchObject({ ok: false, reason: "forbidden" });

		await as(owner, {
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "qa", moveTo: "in_review" },
		});
		const snapshot = await workspace.snapshot(alice);
		expect(snapshot.statuses).toContainEqual(
			expect.objectContaining({ key: "qa", name: "QA", removedAt: expect.any(Number) }),
		);
		expect(snapshot.issues.find((issue) => issue.id === "issue-1")?.status).toBe("in_review");
		expect(snapshot.issues.find((issue) => issue.id === "issue-3")?.status).toBe("todo");
		expect(snapshot.activities).toContainEqual(
			expect.objectContaining({
				issueId: "issue-1",
				actorId: owner.id,
				change: { type: "status", from: "qa", to: "in_review" },
			}),
		);
		expect(snapshot.inbox).toEqual([]);

		// The key stays the removed status's, and nothing moves to it any more.
		expect(await attempt(owner, createStatus({ name: "QA again" }))).toMatchObject({
			ok: false,
			reason: "conflict",
		});
		expect(await attempt(owner, createIssue("issue-4", "qa"))).toMatchObject({
			ok: false,
			reason: "invalid",
		});
	});

	it("give new issues the next status when the first is removed", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, {
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "backlog", moveTo: "todo" },
		});
		await as(alice, createIssue("issue-1"));
		expect((await issueOf(workspace, "issue-1")).status).toBe("todo");
	});

	it("decide what closing is for an agent that proposes it", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, {
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["close"] } },
		});
		await as(owner, createStatus({ key: "shipped", name: "Shipped", category: "completed" }));
		await as(owner, createStatus());
		await as(triage, createIssue("issue-1"));

		let issue = await issueOf(workspace, "issue-1");
		const toQa = await as(triage, {
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { status: "qa" } },
		});
		expect(toQa.proposed).toEqual([]);
		issue = await issueOf(workspace, "issue-1");
		expect(issue.status).toBe("qa");

		const toShipped = await as(triage, {
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { status: "shipped" } },
		});
		expect(toShipped.proposed).toEqual([
			expect.objectContaining({ change: { type: "status", to: "shipped" } }),
		]);
		expect((await issueOf(workspace, "issue-1")).status).toBe("qa");
	});

	it("are given to every team of an existing workspace by the migration", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, { name: "team.create", args: { id: "team-ops", key: "OPS", name: "Ops" } });
		await as(owner, createIssue("issue-1", "in_review"));

		// Undo the statuses' migrations, then run them again, as when a workspace wakes up after
		// the deploy that brings them.
		const first = migrations.journal.entries.find(
			(entry) => entry.tag === "0018_ambiguous_maggott",
		);
		if (!first) throw new Error("No statuses migration");
		await runInDurableObject(workspace, async (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`drop table statuses`);
			db.run(sql`alter table issues drop column archived_at`);
			db.run(sql`alter table teams drop column archive_after_months`);
			db.run(sql`alter table teams drop column close_after_months`);
			db.run(sql`drop table templates`);
			db.run(sql`delete from __drizzle_migrations where created_at >= ${first.when}`);
			await migrate(db, migrations);
		});

		const snapshot = await workspace.snapshot(owner);
		for (const teamId of [TEAM_ID, "team-ops"]) {
			expect(
				snapshot.statuses
					.filter((status) => status.teamId === teamId)
					.map(({ id, key, name, category, color, sortOrder, removedAt }) => ({
						id,
						key,
						name,
						category,
						color,
						sortOrder,
						removedAt,
					})),
			).toEqual(
				DEFAULT_STATUSES.map((status) => ({
					...status,
					id: statusId(teamId, status.key),
					removedAt: null,
				})),
			);
		}
		expect((await issueOf(workspace, "issue-1")).status).toBe("in_review");
	});
});
