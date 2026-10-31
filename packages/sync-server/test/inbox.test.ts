import { runInDurableObject } from "cloudflare:test";
import {
	type InboxItem,
	type MutationInput,
	privateId,
	type Subscription,
} from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { freshWorkspace, TestClient, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const bob: MemberProfile = { ...owner, id: "user-bob", name: "Bob", role: "member" };
const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
const TEAM_ID = "team-1";
const ISSUE_ID = "issue-1";

/** A workspace with a team and every test member in it. */
async function workspaceWithTeam() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, bob, triage]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	return { workspace, as };
}

async function inboxOf(workspace: Workspace, member: MemberProfile): Promise<InboxItem[]> {
	return (await workspace.snapshot(member)).inbox;
}

async function itemOf(workspace: Workspace, member: MemberProfile, issueId = ISSUE_ID) {
	return (await inboxOf(workspace, member)).find((item) => item.issueId === issueId);
}

async function subscriptionOf(
	workspace: Workspace,
	member: MemberProfile,
	issueId = ISSUE_ID,
): Promise<Subscription | undefined> {
	return (await workspace.snapshot(member)).subscriptions.find((row) => row.issueId === issueId);
}

const createIssue = (args: { assigneeId?: string | null; createdAt?: number } = {}) =>
	({
		name: "issue.create",
		args: { id: ISSUE_ID, teamId: TEAM_ID, title: "Ship the inbox", sortOrder: "a0", ...args },
	}) satisfies MutationInput;

const comment = (id: string, body = "Looks good") =>
	({ name: "comment.create", args: { id, issueId: ISSUE_ID, body } }) satisfies MutationInput;

async function update(
	workspace: Workspace,
	as: (member: MemberProfile, mutation: MutationInput) => Promise<unknown>,
	member: MemberProfile,
	patch: { status?: "todo" | "in_progress" | "done"; assigneeId?: string | null },
) {
	const issue = (await workspace.snapshot(owner)).issues.find((row) => row.id === ISSUE_ID);
	if (!issue) throw new Error("No issue");
	await as(member, {
		name: "issue.update",
		args: { id: ISSUE_ID, baseVersion: issue.version, patch },
	});
}

const inboxUpdate = (
	items: { issueId: string; seen: number }[],
	patch: { read?: boolean; archived?: boolean; snoozedUntil?: number | null },
) => ({ name: "inbox.update", args: { items, patch } }) satisfies MutationInput;

describe("private rows", () => {
	it("sends a member's subscription to them alone, and keeps everyone's deltas continuous", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue());
		const watcher = await TestClient.live(workspace, bob);
		const subscriber = await TestClient.live(workspace, alice);

		const { version } = await as(alice, {
			name: "issue.subscribe",
			args: { issueId: ISSUE_ID, subscribed: true },
		});
		const op = await subscriber.op((op) => op.entity === "subscription");
		expect(op).toMatchObject({
			op: "put",
			id: privateId(ISSUE_ID, alice.id),
			data: { issueId: ISSUE_ID, memberId: alice.id, subscribed: true },
		});

		// Bob hears nothing of it; his next delta covers its version without the op.
		await as(owner, comment("comment-1"));
		await watcher.op((op) => op.entity === "comment");
		expect(watcher.ops().some((op) => op.entity === "subscription")).toBe(false);
		expect(watcher.ops().find((op) => op.entity === "comment")?.version).toBeGreaterThan(version);

		expect(await subscriptionOf(workspace, alice)).toMatchObject({ subscribed: true });
		expect(await subscriptionOf(workspace, bob)).toBeUndefined();
	});

	it("leaves other members' private ops out of catch-up", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue());
		const before = (await workspace.snapshot(bob)).version;
		await as(alice, { name: "issue.subscribe", args: { issueId: ISSUE_ID, subscribed: true } });
		const head = (await workspace.snapshot(owner)).version;

		const returning = await TestClient.connect(workspace, bob);
		expect(await returning.hello(before)).toEqual({ type: "ready", version: head });
		expect(returning.ops()).toEqual([]);
		expect(returning.through).toBe(head);

		const own = await TestClient.connect(workspace, alice);
		await own.hello(before);
		expect(own.ops().map((op) => op.entity)).toEqual(["subscription"]);
	});
});

describe("subscriptions", () => {
	it("subscribes the creator and the assignee, and tells the assignee", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));

		expect(await subscriptionOf(workspace, owner)).toMatchObject({ subscribed: true });
		expect(await subscriptionOf(workspace, alice)).toMatchObject({ subscribed: true });
		expect(await itemOf(workspace, alice)).toMatchObject({
			event: { type: "assigned" },
			actorId: owner.id,
			unread: 1,
			archivedAt: null,
			snoozedUntil: null,
		});
		// Nobody hears of what they did themselves.
		expect(await inboxOf(workspace, owner)).toEqual([]);
	});

	it("subscribes commenters and tells the other subscribers", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue());
		await as(bob, comment("comment-1"));
		expect(await subscriptionOf(workspace, bob)).toMatchObject({ subscribed: true });
		expect(await itemOf(workspace, owner)).toMatchObject({
			event: { type: "comment", commentId: "comment-1" },
			actorId: bob.id,
			unread: 1,
		});

		await as(alice, comment("comment-2"));
		expect(await itemOf(workspace, owner)).toMatchObject({
			event: { type: "comment", commentId: "comment-2" },
			actorId: alice.id,
			unread: 2,
		});
		expect(await itemOf(workspace, bob)).toMatchObject({ actorId: alice.id, unread: 1 });
		expect(await itemOf(workspace, alice)).toBeUndefined();
	});

	it("tells subscribers of status changes, and moves assignments", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));
		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: Date.now() }], { read: true }));

		await update(workspace, as, alice, { status: "in_progress" });
		expect(await itemOf(workspace, owner)).toMatchObject({
			event: { type: "status", from: "backlog", to: "in_progress" },
			actorId: alice.id,
		});

		// Bob was not subscribed to hear of the status change, only of being assigned. Alice
		// hears of both, and her item shows the latest.
		await update(workspace, as, owner, { status: "todo", assigneeId: bob.id });
		expect(await itemOf(workspace, bob)).toMatchObject({ event: { type: "assigned" }, unread: 1 });
		expect(await itemOf(workspace, alice)).toMatchObject({
			event: { type: "unassigned" },
			actorId: owner.id,
			unread: 2,
		});
	});

	it("keeps an unsubscribed member out until they are assigned again", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));
		await as(alice, { name: "issue.subscribe", args: { issueId: ISSUE_ID, subscribed: false } });
		const before = await itemOf(workspace, alice);

		await as(bob, comment("comment-1"));
		await as(alice, comment("comment-2"));
		await as(bob, comment("comment-3"));
		expect(await subscriptionOf(workspace, alice)).toMatchObject({ subscribed: false });
		expect(await itemOf(workspace, alice)).toEqual(before);
		// Unassigning tells only those still subscribed.
		await update(workspace, as, owner, { assigneeId: null });
		expect(await itemOf(workspace, alice)).toEqual(before);

		await update(workspace, as, owner, { assigneeId: alice.id });
		expect(await subscriptionOf(workspace, alice)).toMatchObject({ subscribed: true });
		expect(await itemOf(workspace, alice)).toMatchObject({ event: { type: "assigned" } });
	});

	it("tells subscribers of agents' proposals, and gives agents no inbox", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, {
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["status"] } },
		});
		await as(owner, createIssue({ assigneeId: triage.id }));
		expect(await subscriptionOf(workspace, triage)).toBeUndefined();

		await update(workspace, as, triage, { status: "done" });
		const [proposal] = (await workspace.snapshot(owner)).proposals;
		expect(await itemOf(workspace, owner)).toMatchObject({
			event: {
				type: "proposal",
				proposalId: proposal?.id,
				change: { type: "status", to: "done" },
			},
			actorId: triage.id,
		});
		await as(triage, comment("comment-1"));
		expect((await workspace.snapshot(triage)).subscriptions).toEqual([]);
		expect(await inboxOf(workspace, triage)).toEqual([]);

		const refused = await workspace.mutate(triage, "client-bot", "m-sub", {
			name: "issue.subscribe",
			args: { issueId: ISSUE_ID, subscribed: true },
		});
		expect(refused).toMatchObject({ ok: false, reason: "forbidden" });
	});

	it("tells nobody of imported issues and comments, and leaves the importer out", async () => {
		const { workspace, as } = await workspaceWithTeam();
		const createdAt = Date.UTC(2024, 0, 1);
		await as(owner, createIssue({ assigneeId: alice.id, createdAt }));
		await as(owner, {
			name: "comment.create",
			args: { id: "comment-1", issueId: ISSUE_ID, body: "From before", createdAt },
		});

		expect(await subscriptionOf(workspace, alice)).toMatchObject({ subscribed: true });
		expect(await subscriptionOf(workspace, owner)).toBeUndefined();
		expect(await inboxOf(workspace, alice)).toEqual([]);
	});

	it("refuses to subscribe to a missing issue", async () => {
		const { workspace } = await workspaceWithTeam();
		const result = await workspace.mutate(alice, "client", "m", {
			name: "issue.subscribe",
			args: { issueId: "nope", subscribed: true },
		});
		expect(result).toMatchObject({ ok: false, reason: "not_found" });
	});
});

describe("inbox.update", () => {
	async function withItem() {
		const setup = await workspaceWithTeam();
		await setup.as(owner, createIssue({ assigneeId: alice.id }));
		const item = await itemOf(setup.workspace, alice);
		if (!item) throw new Error("No inbox item");
		return { ...setup, item };
	}

	it("reads and unreads an item", async () => {
		const { workspace, as, item } = await withItem();
		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: item.updatedAt }], { read: true }));
		expect(await itemOf(workspace, alice)).toMatchObject({ unread: 0 });

		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: 0 }], { read: false }));
		expect(await itemOf(workspace, alice)).toMatchObject({ unread: 1 });
	});

	it("leaves an item unread when it had news the reader had not seen", async () => {
		const { workspace, as, item } = await withItem();
		await as(bob, comment("comment-1"));
		const result = await as(
			alice,
			inboxUpdate([{ issueId: ISSUE_ID, seen: item.updatedAt - 1 }], {
				read: true,
				archived: true,
				snoozedUntil: Date.now() + 60_000,
			}),
		);
		expect(await itemOf(workspace, alice)).toMatchObject({
			unread: 2,
			archivedAt: null,
			snoozedUntil: null,
		});
		// Nothing changed, so nothing was written.
		expect(result.version).toBe((await workspace.snapshot(owner)).version);
	});

	it("archives and snoozes until news brings the item back", async () => {
		const { workspace, as, item } = await withItem();
		const until = Date.now() + 3_600_000;
		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: item.updatedAt }], { archived: true }));
		expect(await itemOf(workspace, alice)).toMatchObject({
			unread: 0,
			archivedAt: expect.any(Number),
		});
		await as(
			alice,
			inboxUpdate([{ issueId: ISSUE_ID, seen: item.updatedAt }], { snoozedUntil: until }),
		);
		expect(await itemOf(workspace, alice)).toMatchObject({ snoozedUntil: until });

		await as(bob, comment("comment-1"));
		expect(await itemOf(workspace, alice)).toMatchObject({
			unread: 1,
			archivedAt: null,
			snoozedUntil: null,
		});

		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: 0 }], { snoozedUntil: until }));
		expect(await itemOf(workspace, alice)).toMatchObject({ snoozedUntil: null });
		await as(
			alice,
			inboxUpdate([{ issueId: ISSUE_ID, seen: Date.now() }], { snoozedUntil: until }),
		);
		await as(alice, inboxUpdate([{ issueId: ISSUE_ID, seen: 0 }], { snoozedUntil: null }));
		expect(await itemOf(workspace, alice)).toMatchObject({ snoozedUntil: null });
	});

	it("skips items that do not exist, and changes only the member's own", async () => {
		const { workspace, as, item } = await withItem();
		await as(
			bob,
			inboxUpdate(
				[
					{ issueId: ISSUE_ID, seen: item.updatedAt },
					{ issueId: "missing", seen: 0 },
				],
				{ read: true },
			),
		);
		expect(await itemOf(workspace, alice)).toMatchObject({ unread: 1 });
	});

	it("refuses agents", async () => {
		const { workspace } = await withItem();
		const result = await workspace.mutate(
			triage,
			"client-bot",
			"m-read",
			inboxUpdate([{ issueId: ISSUE_ID, seen: 0 }], { read: true }),
		);
		expect(result).toMatchObject({ ok: false, reason: "forbidden" });
	});
});

describe("cleanup", () => {
	it("removes a deleted issue's subscriptions and inbox items, telling only their members", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));
		const subscriber = await TestClient.live(workspace, alice);
		const watcher = await TestClient.live(workspace, bob);

		await as(owner, { name: "issue.delete", args: { id: ISSUE_ID } });
		await subscriber.op((op) => op.entity === "issue" && op.op === "delete");
		expect(
			subscriber
				.ops()
				.filter(
					(op) => op.op === "delete" && (op.entity === "subscription" || op.entity === "inbox"),
				)
				.map((op) => [op.entity, op.op, op.id]),
		).toEqual([
			["subscription", "delete", privateId(ISSUE_ID, alice.id)],
			["inbox", "delete", privateId(ISSUE_ID, alice.id)],
		]);
		await watcher.op((op) => op.entity === "issue" && op.op === "delete");
		expect(watcher.ops().some((op) => op.entity === "subscription" || op.entity === "inbox")).toBe(
			false,
		);
		expect(await workspace.snapshot(alice)).toMatchObject({ subscriptions: [], inbox: [] });
		expect((await workspace.snapshot(owner)).subscriptions).toEqual([]);
	});

	it("removes a departing member's subscriptions and inbox", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));
		await workspace.removeMember(alice.id);
		await workspace.syncMember(alice);
		expect(await workspace.snapshot(alice)).toMatchObject({ subscriptions: [], inbox: [] });
	});

	it("tells nobody twice when a mutation is retried", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue());
		const retried = comment("comment-1");
		await workspace.mutate(bob, "client-bob", "m-retry", retried);
		await workspace.mutate(bob, "client-bob", "m-retry", retried);
		expect(await itemOf(workspace, owner)).toMatchObject({ unread: 1 });
	});
});

describe("workspaces from before the inbox", () => {
	it("subscribes the creators, assignees and commenters of live issues", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: alice.id }));
		await as(bob, comment("comment-1"));
		await as(triage, comment("comment-2"));
		await as(owner, {
			name: "issue.create",
			args: { id: "issue-2", teamId: TEAM_ID, title: "Deleted", sortOrder: "a1" },
		});
		await as(owner, { name: "issue.delete", args: { id: "issue-2" } });

		// Undo the inbox's migrations, then run them again, as when a workspace wakes up after the
		// deploy that brings the inbox.
		const inbox = migrations.journal.entries.find((entry) => entry.tag === "0012_inbox");
		if (!inbox) throw new Error("No inbox migration");
		await runInDurableObject(workspace, async (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`drop table inbox_items`);
			db.run(sql`drop table subscriptions`);
			db.run(sql`alter table oplog drop column audience`);
			db.run(sql`delete from __drizzle_migrations where created_at >= ${inbox.when}`);
			await migrate(db, migrations);
		});

		for (const member of [owner, alice, bob]) {
			expect((await workspace.snapshot(member)).subscriptions).toEqual([
				expect.objectContaining({ issueId: ISSUE_ID, memberId: member.id, subscribed: true }),
			]);
		}
		expect((await workspace.snapshot(triage)).subscriptions).toEqual([]);
		expect(await inboxOf(workspace, owner)).toEqual([]);
	});
});
