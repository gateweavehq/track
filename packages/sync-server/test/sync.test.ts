import { runInDurableObject } from "cloudflare:test";
import {
	CloseCode,
	type Issue,
	MAX_LABELS_PER_ISSUE,
	type MutationInput,
	PING,
	PONG,
} from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { compact } from "../src/log";
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

const TEAM_ID = "team-eng";

type IssuePatch = Extract<MutationInput, { name: "issue.update" }>["args"]["patch"];

async function withTeam() {
	const workspace = freshWorkspace();
	const admin = await TestClient.live(workspace, owner);
	await admin.apply({
		name: "team.create",
		args: { id: TEAM_ID, key: "ENG", name: "Engineering" },
	});
	return { workspace, admin };
}

async function createIssue(client: TestClient, id: string, title = "Ship sync") {
	await client.apply({
		name: "issue.create",
		args: { id, teamId: TEAM_ID, title, sortOrder: "a0" },
	});
	return issueOf(client, id);
}

/** Latest state of an issue as seen by `client`. */
async function issueOf(client: TestClient, id: string): Promise<Issue> {
	await client.op((op) => op.entity === "issue" && op.id === id);
	const op = client
		.ops()
		.filter((op) => op.entity === "issue" && op.id === id)
		.at(-1);
	if (op?.op !== "put" || op.entity !== "issue") throw new Error(`Issue ${id} is not live`);
	return op.data;
}

async function snapshotOf(workspace: Workspace) {
	return workspace.snapshot(owner);
}

describe("connection", () => {
	it("catches a new client up and marks it live", async () => {
		const workspace = freshWorkspace();
		const client = await TestClient.connect(workspace, owner);

		const ready = await client.hello();

		// Connecting registers the member, which is the first op.
		expect(ready).toEqual({ type: "ready", version: 1 });
		expect(client.ops()).toEqual([
			{
				version: 1,
				entity: "member",
				id: owner.id,
				op: "put",
				data: { ...owner, removedAt: null },
			},
		]);
	});

	it("schedules oplog compaction", async () => {
		const workspace = freshWorkspace();
		await snapshotOf(workspace);
		await runInDurableObject(workspace, async (_, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});
	});

	it("answers keepalive pings", async () => {
		const workspace = freshWorkspace();
		const response = await workspace.fetch("https://workspace/socket", {
			headers: { Upgrade: "websocket", "x-track-member": JSON.stringify(owner) },
		});
		const ws = response.webSocket;
		if (!ws) throw new Error("no socket");
		ws.accept();
		const pong = new Promise<string>((resolve) =>
			ws.addEventListener("message", (event) => resolve(event.data as string)),
		);
		ws.send(PING);
		expect(await pong).toBe(PONG);
	});

	it("closes on a protocol mismatch", async () => {
		const client = await TestClient.connect(freshWorkspace(), owner);
		client.send({ type: "hello", protocol: 999, clientId: client.clientId, since: 0 });
		expect((await client.closed()).code).toBe(CloseCode.ProtocolMismatch);
	});

	it("closes on messages that are not protocol", async () => {
		const client = await TestClient.connect(freshWorkspace(), owner);
		client.send("{not json");
		expect((await client.closed()).code).toBe(CloseCode.InvalidMessage);
	});

	it("requires hello before mutations", async () => {
		const client = await TestClient.connect(freshWorkspace(), owner);
		client.send({
			type: "mutate",
			id: "m1",
			mutation: { name: "issue.delete", args: { id: "x" } },
		});
		expect((await client.closed()).code).toBe(CloseCode.InvalidMessage);
	});

	it("rejects non-socket requests", async () => {
		const response = await freshWorkspace().fetch("https://workspace/socket");
		expect(response.status).toBe(404);
	});
});

describe("catch-up", () => {
	it("replays missed ops to a reconnecting client", async () => {
		const { workspace, admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");

		const returning = await TestClient.connect(workspace, owner);
		const ready = await returning.hello(issue.version - 1);

		expect(ready).toEqual({ type: "ready", version: issue.version });
		expect(returning.ops().map((op) => op.version)).toEqual([issue.version]);
	});

	it("resets clients that are ahead of the server", async () => {
		const client = await TestClient.connect(freshWorkspace(), owner);
		expect(await client.hello(1_000)).toEqual({ type: "reset" });
	});

	it("resets clients behind the compaction floor, and keeps recent ops", async () => {
		const { workspace, admin } = await withTeam();
		for (let i = 1; i <= 5; i++) await createIssue(admin, `issue-${i}`);
		const head = (await snapshotOf(workspace)).version;

		await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			compact(db, Date.now() + 1, { minOps: 2, minAgeMs: 0 });
		});

		const behind = await TestClient.connect(workspace, owner);
		expect(await behind.hello(0)).toEqual({ type: "reset" });

		const recent = await TestClient.connect(workspace, owner);
		expect(await recent.hello(head - 2)).toEqual({ type: "ready", version: head });
		expect(recent.ops().map((op) => op.version)).toEqual([head - 1, head]);
	});
});

describe("teams", () => {
	it("broadcasts new teams to other live clients", async () => {
		const workspace = freshWorkspace();
		const admin = await TestClient.live(workspace, owner);
		const viewer = await TestClient.live(workspace, alice);

		await admin.apply({
			name: "team.create",
			args: { id: TEAM_ID, key: "ENG", name: "Engineering" },
		});

		const op = await viewer.op((op) => op.entity === "team");
		expect(op).toMatchObject({ op: "put", data: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	});

	it("only lets admins manage teams", async () => {
		const { workspace } = await withTeam();
		const member = await TestClient.live(workspace, alice);

		const result = await member.mutate({
			name: "team.update",
			args: { id: TEAM_ID, patch: { name: "Platform" } },
		});
		expect(result).toMatchObject({ type: "reject", reason: "forbidden" });
	});

	it("keeps team keys unique", async () => {
		const { admin } = await withTeam();
		const result = await admin.mutate({
			name: "team.create",
			args: { id: "team-2", key: "ENG", name: "Engine" },
		});
		expect(result).toMatchObject({ type: "reject", reason: "conflict" });
	});
});

describe("issues", () => {
	it("numbers issues sequentially per team", async () => {
		const { admin } = await withTeam();
		await admin.apply({
			name: "team.create",
			args: { id: "team-des", key: "DES", name: "Design" },
		});

		const first = await createIssue(admin, "issue-1");
		const second = await createIssue(admin, "issue-2");
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-3", teamId: "team-des", title: "Logo", sortOrder: "a0" },
		});
		const design = await issueOf(admin, "issue-3");

		expect([first.number, second.number, design.number]).toEqual([1, 2, 1]);
		expect(first).toMatchObject({
			status: "backlog",
			priority: 0,
			assigneeId: null,
			creatorId: owner.id,
		});
	});

	it("treats a replayed mutation id as already applied", async () => {
		const { workspace, admin } = await withTeam();
		const mutation = {
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Once", sortOrder: "a0" },
		} as const;

		const first = await admin.apply(mutation, "m-1");
		const replay = await admin.apply(mutation, "m-1");

		expect(replay.version).toBe(first.version);
		expect((await snapshotOf(workspace)).issues).toHaveLength(1);
	});

	it("rejects a mutation id reused by a different client", async () => {
		const { workspace, admin } = await withTeam();
		await createIssue(admin, "issue-1");
		const other = await TestClient.live(workspace, alice);
		await admin.apply({ name: "issue.delete", args: { id: "issue-1" } }, "m-shared");

		const result = await other.mutate(
			{ name: "issue.delete", args: { id: "issue-1" } },
			"m-shared",
		);
		expect(result).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("rejects duplicate issue ids without consuming a number", async () => {
		const { admin } = await withTeam();
		await createIssue(admin, "issue-1");

		const duplicate = await admin.mutate({
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Again", sortOrder: "a1" },
		});
		const next = await createIssue(admin, "issue-2");

		expect(duplicate).toMatchObject({ type: "reject", reason: "invalid" });
		expect(next.number).toBe(2);
	});

	it("rejects invalid payloads and keeps the connection", async () => {
		const { admin } = await withTeam();
		const result = await admin.mutate({
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "", sortOrder: "a0" },
		});
		expect(result).toMatchObject({ type: "reject", reason: "invalid" });
		await createIssue(admin, "issue-2");
	});

	it("only assigns active members", async () => {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(alice);
		const issue = await createIssue(admin, "issue-1");

		const stranger = await admin.mutate({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { assigneeId: "user-nobody" } },
		});
		await admin.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { assigneeId: alice.id } },
		});

		expect(stranger).toMatchObject({ type: "reject", reason: "invalid" });
		expect((await issueOf(admin, issue.id)).assigneeId).toBe(alice.id);
	});

	it("broadcasts deletes and treats deleted issues as gone", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");

		await admin.apply({ name: "issue.delete", args: { id: issue.id } });
		const update = await admin.mutate({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Zombie" } },
		});

		expect(await viewer.op((op) => op.op === "delete")).toMatchObject({
			entity: "issue",
			id: issue.id,
		});
		expect(update).toMatchObject({ type: "reject", reason: "not_found" });
		expect((await snapshotOf(workspace)).issues).toEqual([]);
	});
});

describe("concurrent edits", () => {
	async function twoEditors() {
		const { workspace, admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1", "Original");
		const a = await TestClient.live(workspace, alice);
		const b = await TestClient.live(workspace, bob);
		return { workspace, a, b, admin, issue };
	}

	it("merges edits to different fields", async () => {
		const { a, b, admin, issue } = await twoEditors();

		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Renamed" } },
		});
		await b.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { priority: 1 } },
		});

		expect(await issueOf(admin, issue.id)).toMatchObject({ title: "Renamed", priority: 1 });
	});

	it("rejects a stale edit to a field another client changed", async () => {
		const { a, b, admin, issue } = await twoEditors();

		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "First" } },
		});
		const stale = await b.mutate({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Second" } },
		});

		expect(stale).toMatchObject({ type: "reject", reason: "conflict" });
		expect((await issueOf(admin, issue.id)).title).toBe("First");
	});

	it("applies a client's rapid successive edits to the same field", async () => {
		const { a, admin, issue } = await twoEditors();

		// Both edits are based on the same version because the first ack has not arrived yet.
		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Ship" } },
		});
		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Ship it" } },
		});

		expect((await issueOf(admin, issue.id)).title).toBe("Ship it");
	});

	it("applies the non-conflicting part of a partially stale patch", async () => {
		const { a, b, admin, issue } = await twoEditors();

		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "First" } },
		});
		await b.apply({
			name: "issue.update",
			args: {
				id: issue.id,
				baseVersion: issue.version,
				patch: { title: "Second", status: "todo" },
			},
		});

		expect(await issueOf(admin, issue.id)).toMatchObject({ title: "First", status: "todo" });
	});

	it("does not write when a patch changes nothing", async () => {
		const { workspace, a, issue } = await twoEditors();
		const head = (await snapshotOf(workspace)).version;
		const result = await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { title: "Original" } },
		});
		expect(result.version).toBe(head);
	});
});

describe("labels", () => {
	async function createLabel(client: TestClient, id: string, name: string) {
		await client.apply({ name: "label.create", args: { id, name, color: "#e5484d" } });
	}

	it("creates and renames labels, keeping names unique ignoring case", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		await createLabel(member, "label-bug", "Bug");
		await createLabel(member, "label-docs", "Docs");

		const duplicate = await admin.mutate({
			name: "label.create",
			args: { id: "label-2", name: "bug", color: "#0090ff" },
		});
		const rename = await admin.mutate({
			name: "label.update",
			args: { id: "label-docs", patch: { name: "BUG" } },
		});
		await member.apply({
			name: "label.update",
			args: { id: "label-bug", patch: { name: "Defect", color: "#46a758" } },
		});

		expect(duplicate).toMatchObject({ type: "reject", reason: "conflict" });
		expect(rename).toMatchObject({ type: "reject", reason: "conflict" });
		expect(
			await admin.op((op) => op.entity === "label" && op.op === "put" && op.data.name === "Defect"),
		).toMatchObject({ data: { id: "label-bug", color: "#46a758" } });
	});

	it("adds and removes labels as sets, so concurrent changes all land", async () => {
		const { workspace, admin } = await withTeam();
		const other = await TestClient.live(workspace, alice);
		await createLabel(admin, "label-bug", "Bug");
		await createLabel(admin, "label-docs", "Docs");
		const issue = await createIssue(admin, "issue-1");

		await admin.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-bug" } });
		await other.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-docs" } });
		const again = await other.apply({
			name: "issue.addLabel",
			args: { id: issue.id, labelId: "label-docs" },
		});
		const absent = await admin.apply({
			name: "issue.removeLabel",
			args: { id: "issue-1", labelId: "label-missing" },
		});

		expect((await issueOf(admin, issue.id)).labelIds).toEqual(["label-bug", "label-docs"]);
		// Repeats change nothing, so they write nothing.
		expect(absent.version).toBe(again.version);

		await other.apply({ name: "issue.removeLabel", args: { id: issue.id, labelId: "label-bug" } });
		expect((await issueOf(admin, issue.id)).labelIds).toEqual(["label-docs"]);
	});

	it("rejects unknown labels and issues", async () => {
		const { admin } = await withTeam();
		await createLabel(admin, "label-bug", "Bug");
		const issue = await createIssue(admin, "issue-1");
		await admin.apply({ name: "issue.delete", args: { id: issue.id } });

		const unknownLabel = await admin.mutate({
			name: "issue.create",
			args: { id: "issue-2", teamId: TEAM_ID, title: "Hm", labelIds: ["nope"], sortOrder: "a1" },
		});
		const deletedIssue = await admin.mutate({
			name: "issue.addLabel",
			args: { id: issue.id, labelId: "label-bug" },
		});
		const created = await createIssue(admin, "issue-3");

		expect(unknownLabel).toMatchObject({ type: "reject", reason: "not_found" });
		expect(deletedIssue).toMatchObject({ type: "reject", reason: "not_found" });
		// The rejected create did not use up a number.
		expect(created.number).toBe(2);
	});

	it("creates issues with labels, once each", async () => {
		const { admin } = await withTeam();
		await createLabel(admin, "label-bug", "Bug");

		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: TEAM_ID,
				title: "Labeled",
				labelIds: ["label-bug", "label-bug"],
				sortOrder: "a0",
			},
		});

		expect((await issueOf(admin, "issue-1")).labelIds).toEqual(["label-bug"]);
	});

	it("caps the labels on one issue", async () => {
		const { admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");
		for (let i = 0; i <= MAX_LABELS_PER_ISSUE; i++) await createLabel(admin, `label-${i}`, `L${i}`);
		for (let i = 0; i < MAX_LABELS_PER_ISSUE; i++) {
			await admin.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: `label-${i}` } });
		}

		const over = await admin.mutate({
			name: "issue.addLabel",
			args: { id: issue.id, labelId: `label-${MAX_LABELS_PER_ISSUE}` },
		});

		expect(over).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("lets only admins delete a label, which leaves every issue", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		await createLabel(admin, "label-bug", "Bug");
		await createLabel(admin, "label-docs", "Docs");
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: TEAM_ID,
				title: "Both",
				labelIds: ["label-bug", "label-docs"],
				sortOrder: "a0",
			},
		});

		const forbidden = await member.mutate({ name: "label.delete", args: { id: "label-bug" } });
		await admin.apply({ name: "label.delete", args: { id: "label-bug" } });
		const reuse = await admin.mutate({
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});

		expect(forbidden).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(await member.op((op) => op.entity === "label" && op.op === "delete")).toMatchObject({
			id: "label-bug",
		});
		expect((await issueOf(member, "issue-1")).labelIds).toEqual(["label-docs"]);
		expect(reuse).toMatchObject({ type: "reject", reason: "not_found" });
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.labels.map((label) => label.id)).toEqual(["label-docs"]);
		expect(snapshot.issues[0]?.labelIds).toEqual(["label-docs"]);
	});
});

describe("comments", () => {
	async function comment(client: TestClient, id: string, issueId: string, body = "Looks good") {
		return client.apply({ name: "comment.create", args: { id, issueId, body } });
	}

	it("lets any member comment, and only the author edit", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");

		await comment(member, "comment-1", issue.id, "  First!  ");
		const byAdmin = await admin.mutate({
			name: "comment.update",
			args: { id: "comment-1", body: "Rewritten" },
		});
		const edited = await member.apply({
			name: "comment.update",
			args: { id: "comment-1", body: "First, edited" },
		});
		const same = await member.apply({
			name: "comment.update",
			args: { id: "comment-1", body: "First, edited" },
		});

		expect(
			await admin.op((op) => op.entity === "comment" && op.op === "put" && op.id === "comment-1"),
		).toMatchObject({ data: { issueId: issue.id, authorId: alice.id, body: "First!" } });
		expect(byAdmin).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(
			await admin.op(
				(op) => op.entity === "comment" && op.op === "put" && op.data.body === "First, edited",
			),
		).toMatchObject({ id: "comment-1" });
		// An edit that changes nothing writes nothing.
		expect(same.version).toBe(edited.version);
		expect((await snapshotOf(workspace)).comments).toMatchObject([
			{ id: "comment-1", body: "First, edited", authorId: alice.id },
		]);
	});

	it("lets the author or an admin delete a comment", async () => {
		const { workspace, admin } = await withTeam();
		const author = await TestClient.live(workspace, alice);
		const other = await TestClient.live(workspace, bob);
		const issue = await createIssue(admin, "issue-1");
		await comment(author, "comment-1", issue.id);
		await comment(author, "comment-2", issue.id);

		const byOther = await other.mutate({ name: "comment.delete", args: { id: "comment-1" } });
		await author.apply({ name: "comment.delete", args: { id: "comment-1" } });
		await admin.apply({ name: "comment.delete", args: { id: "comment-2" } });
		const editDeleted = await author.mutate({
			name: "comment.update",
			args: { id: "comment-1", body: "Back" },
		});

		expect(byOther).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(
			await other.op(
				(op) => op.entity === "comment" && op.op === "delete" && op.id === "comment-2",
			),
		).toBeTruthy();
		expect(editDeleted).toMatchObject({ type: "reject", reason: "not_found" });
		expect((await snapshotOf(workspace)).comments).toEqual([]);
	});

	it("rejects empty comments, reused ids and comments on missing issues", async () => {
		const { admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");
		await comment(admin, "comment-1", issue.id);

		const empty = await admin.mutate({
			name: "comment.create",
			args: { id: "comment-2", issueId: issue.id, body: "   " },
		});
		const reused = await admin.mutate({
			name: "comment.create",
			args: { id: "comment-1", issueId: issue.id, body: "Again" },
		});
		const missing = await admin.mutate({
			name: "comment.create",
			args: { id: "comment-3", issueId: "issue-missing", body: "Hello?" },
		});

		expect(empty).toMatchObject({ type: "reject", reason: "invalid" });
		expect(reused).toMatchObject({ type: "reject", reason: "invalid" });
		expect(missing).toMatchObject({ type: "reject", reason: "not_found" });
	});

	it("drops an issue's comments and history along with the issue", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");
		await comment(member, "comment-1", issue.id);
		await member.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { status: "todo" } },
		});
		const activity = await admin.op((op) => op.entity === "activity" && op.op === "put");

		await admin.apply({ name: "issue.delete", args: { id: issue.id } });
		const late = await member.mutate({
			name: "comment.create",
			args: { id: "comment-2", issueId: issue.id, body: "Too late" },
		});
		const editOrphan = await member.mutate({
			name: "comment.update",
			args: { id: "comment-1", body: "Still here?" },
		});

		expect(await member.op((op) => op.entity === "comment" && op.op === "delete")).toMatchObject({
			id: "comment-1",
		});
		expect(await member.op((op) => op.entity === "activity" && op.op === "delete")).toMatchObject({
			id: activity.id,
		});
		expect(late).toMatchObject({ type: "reject", reason: "not_found" });
		expect(editOrphan).toMatchObject({ type: "reject", reason: "not_found" });
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.comments).toEqual([]);
		expect(snapshot.activities).toEqual([]);
	});
});

describe("activity", () => {
	async function update(client: TestClient, id: string, patch: IssuePatch) {
		const { version } = await issueOf(client, id);
		const ack = await client.apply({
			name: "issue.update",
			args: { id, baseVersion: version, patch },
		});
		return ack;
	}

	async function historyOf(workspace: Workspace, issueId: string) {
		const { activities } = await snapshotOf(workspace);
		return activities
			.filter((activity) => activity.issueId === issueId)
			.map(({ actorId, change }) => ({ actorId, change }));
	}

	it("records who changed which field", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");
		await issueOf(member, issue.id);

		await update(member, issue.id, { status: "in_progress", assigneeId: alice.id, priority: 2 });
		await update(member, issue.id, { title: "Ship sync faster", sortOrder: "a5" });

		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: alice.id, change: { type: "status", from: "backlog", to: "in_progress" } },
			{ actorId: alice.id, change: { type: "priority", from: 0, to: 2 } },
			{ actorId: alice.id, change: { type: "assignee", from: null, to: alice.id } },
			{ actorId: alice.id, change: { type: "title", from: "Ship sync", to: "Ship sync faster" } },
		]);
	});

	it("merges quick changes to one field, and forgets a change that is put back", async () => {
		const { workspace, admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");

		await update(admin, issue.id, { status: "todo" });
		await update(admin, issue.id, { status: "in_progress" });
		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: owner.id, change: { type: "status", from: "backlog", to: "in_progress" } },
		]);

		await update(admin, issue.id, { status: "backlog" });
		expect(await historyOf(workspace, issue.id)).toEqual([]);
		expect(await admin.op((op) => op.entity === "activity" && op.op === "delete")).toBeTruthy();
	});

	it("keeps changes by different people apart", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");

		const ack = await update(admin, issue.id, { status: "todo" });
		await member.op((op) => op.version === ack.version);
		await update(member, issue.id, { status: "in_progress" });

		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: owner.id, change: { type: "status", from: "backlog", to: "todo" } },
			{ actorId: alice.id, change: { type: "status", from: "todo", to: "in_progress" } },
		]);
	});

	it("records labels added and removed, and a quick toggle leaves nothing", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		await admin.apply({
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#e5484d" },
		});
		const issue = await createIssue(admin, "issue-1");

		await admin.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-bug" } });
		await admin.apply({ name: "issue.removeLabel", args: { id: issue.id, labelId: "label-bug" } });
		expect(await historyOf(workspace, issue.id)).toEqual([]);

		await member.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-bug" } });
		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: alice.id, change: { type: "label", labelId: "label-bug", added: true } },
		]);
	});

	it("leaves out the creator writing an issue, and merges description edits", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");

		await update(admin, issue.id, { title: "Ship sync, properly" });
		await update(admin, issue.id, { description: "Steps…" });
		expect(await historyOf(workspace, issue.id)).toEqual([]);

		const ack = await update(admin, issue.id, { description: "Steps, more" });
		await member.op((op) => op.version === ack.version);
		await update(member, issue.id, { description: "Steps, from Alice" });
		await update(member, issue.id, { description: "Steps, from Alice, again" });
		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: alice.id, change: { type: "description" } },
		]);
	});
});

describe("membership", () => {
	it("disconnects removed members and keeps their profile", async () => {
		const { workspace } = await withTeam();
		const client = await TestClient.live(workspace, alice);

		await workspace.removeMember(alice.id);

		expect((await client.closed()).code).toBe(CloseCode.Forbidden);
		const removed = (await snapshotOf(workspace)).members.find((m) => m.id === alice.id);
		expect(removed?.removedAt).toEqual(expect.any(Number));
	});

	it("wipes all data when the workspace is destroyed", async () => {
		const { workspace } = await withTeam();
		const client = await TestClient.live(workspace, alice);

		await workspace.destroy();

		expect((await client.closed()).code).toBe(CloseCode.Forbidden);
		await runInDurableObject(workspace, async (_, state) => {
			expect(state.storage.sql.databaseSize).toBeLessThan(16_384);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("only emits member ops when the profile changes", async () => {
		const workspace = freshWorkspace();
		const before = (await workspace.snapshot(owner)).version;
		const unchanged = (await workspace.snapshot(owner)).version;
		const renamed = (await workspace.snapshot({ ...owner, name: "Olivia O." })).version;
		expect([unchanged, renamed]).toEqual([before, before + 1]);
	});
});

describe("server-side clients", () => {
	const AGENT = "mcp:test-agent";

	it("applies mutations over RPC and broadcasts them to live clients", async () => {
		const { workspace, admin } = await withTeam();

		const result = await workspace.mutate(alice, AGENT, "m-1", {
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Filed by an agent", sortOrder: "a0" },
		});

		expect(result).toEqual({ ok: true, version: expect.any(Number) });
		const issue = await issueOf(admin, "issue-1");
		expect(issue).toMatchObject({ title: "Filed by an agent", number: 1, creatorId: alice.id });
	});

	it("treats a replayed mutation id as already applied", async () => {
		const { workspace } = await withTeam();
		const create = {
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Once", sortOrder: "a0" },
		};

		const first = await workspace.mutate(alice, AGENT, "m-1", create);
		const again = await workspace.mutate(alice, AGENT, "m-1", create);

		expect(again).toEqual(first);
		expect((await snapshotOf(workspace)).issues).toHaveLength(1);
	});

	it("rejects what a socket client could not do", async () => {
		const { workspace } = await withTeam();

		const forbidden = await workspace.mutate(alice, AGENT, "m-1", {
			name: "team.create",
			args: { id: "team-2", key: "OPS", name: "Operations" },
		});
		const invalid = await workspace.mutate(alice, AGENT, "m-2", {
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "", sortOrder: "a0" },
		});
		const missing = await workspace.mutate(alice, AGENT, "m-3", {
			name: "issue.update",
			args: { id: "nope", baseVersion: 0, patch: { title: "Gone" } },
		});

		expect(forbidden).toMatchObject({ ok: false, reason: "forbidden" });
		expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
		expect(missing).toMatchObject({ ok: false, reason: "not_found" });
	});

	it("keeps field-level conflict detection for agent edits", async () => {
		const { workspace, admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");
		await admin.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { status: "done" } },
		});

		const stale = await workspace.mutate(alice, AGENT, "m-1", {
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { status: "todo" } },
		});

		expect(stale).toMatchObject({ ok: false, reason: "conflict" });
	});

	it("finds issues by team, status, assignee and title", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "issue.create",
			args: { id: "i-1", teamId: TEAM_ID, title: "Fix 100% CPU", sortOrder: "a0" },
		});
		await admin.apply({
			name: "issue.create",
			args: {
				id: "i-2",
				teamId: TEAM_ID,
				title: "Write docs",
				status: "todo",
				assigneeId: owner.id,
				sortOrder: "a1",
			},
		});
		await admin.apply({
			name: "issue.create",
			args: { id: "i-3", teamId: TEAM_ID, title: "Deleted", sortOrder: "a2" },
		});
		await admin.apply({ name: "issue.delete", args: { id: "i-3" } });

		// Sorted, since issues created in the same millisecond have no meaningful order.
		const ids = async (query: Parameters<Workspace["issues"]>[0]) =>
			(await workspace.issues(query)).map((issue) => issue.id).sort();

		expect(await ids({ limit: 10 })).toEqual(["i-1", "i-2"]);
		expect(await ids({ teamId: TEAM_ID, statuses: ["todo"], limit: 10 })).toEqual(["i-2"]);
		expect(await ids({ assigneeId: owner.id, limit: 10 })).toEqual(["i-2"]);
		expect(await ids({ assigneeId: null, limit: 10 })).toEqual(["i-1"]);
		// Text is matched by its words (see "search" below), so a query with none finds nothing.
		expect(await ids({ text: "100%", limit: 10 })).toEqual(["i-1"]);
		expect(await ids({ text: "%", limit: 10 })).toEqual([]);
		expect(await ids({ text: "WRITE", limit: 10 })).toEqual(["i-2"]);
		expect(await ids({ limit: 1 })).toHaveLength(1);
	});

	it("finds issues by label, and lists labels", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#e5484d" },
		});
		await admin.apply({
			name: "issue.create",
			args: { id: "i-1", teamId: TEAM_ID, title: "Bug", labelIds: ["label-bug"], sortOrder: "a0" },
		});
		await createIssue(admin, "i-2");

		const found = await workspace.issues({ labelId: "label-bug", limit: 10 });

		expect(found.map((issue) => issue.id)).toEqual(["i-1"]);
		expect((await workspace.directory()).labels).toMatchObject([{ id: "label-bug", name: "Bug" }]);
	});

	it("looks issues up by id and key, and knows the last sort order", async () => {
		const { workspace, admin } = await withTeam();
		await createIssue(admin, "issue-1");
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-2", teamId: TEAM_ID, title: "Later", sortOrder: "b5" },
		});

		expect(await workspace.issue("issue-2")).toMatchObject({ number: 2, title: "Later" });
		expect(await workspace.issue("missing")).toBeNull();
		expect(await workspace.issueByKey("ENG", 2)).toMatchObject({ id: "issue-2" });
		expect(await workspace.issueByKey("ENG", 3)).toBeNull();
		expect(await workspace.issueByKey("OPS", 1)).toBeNull();
		expect(await workspace.lastSortOrder()).toBe("b5");
	});

	it("lists teams and members", async () => {
		const { workspace } = await withTeam();
		await workspace.syncMember(alice);

		const directory = await workspace.directory();

		expect(directory.teams.map((team) => team.key)).toEqual(["ENG"]);
		expect(directory.members.map((member) => member.id).sort()).toEqual(
			[alice.id, owner.id].sort(),
		);
	});
});

describe("search", () => {
	async function issue(
		client: TestClient,
		id: string,
		title: string,
		description: string | null = null,
	) {
		await client.apply({
			name: "issue.create",
			args: { id, teamId: TEAM_ID, title, description, sortOrder: "a0" },
		});
	}

	/** Ids in the order the search ranks them. */
	const found = async (workspace: Workspace, text: string) =>
		(await workspace.issues({ text, limit: 50 })).map((issue) => issue.id);

	it("finds issues by words in their key, title, description and comments", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "i-1", "Authentication fails on Safari");
		await issue(admin, "i-2", "Dark mode", "Contrast is too low on the authentication page");
		await issue(admin, "i-3", "Exports are slow");
		await admin.apply({
			name: "comment.create",
			args: { id: "c-1", issueId: "i-3", body: "Seen with large workspaces" },
		});

		expect(await found(workspace, "authentication")).toEqual(["i-1", "i-2"]);
		// Each word only has to start a word.
		expect(await found(workspace, "auth")).toEqual(["i-1", "i-2"]);
		expect(await found(workspace, "thent")).toEqual([]);
		expect(await found(workspace, "workspace")).toEqual(["i-3"]);
		// Every word has to match.
		expect(await found(workspace, "auth safari")).toEqual(["i-1"]);
		expect(await found(workspace, "auth exports")).toEqual([]);
		// The key, as people write it.
		expect(await found(workspace, "ENG-3")).toEqual(["i-3"]);
		expect(await found(workspace, "eng 2")).toEqual(["i-2"]);
	});

	it("ignores case and diacritics", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "i-1", "Résumé upload breaks");
		await issue(admin, "i-2", "İstanbul office printer");

		expect(await found(workspace, "resume")).toEqual(["i-1"]);
		expect(await found(workspace, "RÉSUMÉ")).toEqual(["i-1"]);
		expect(await found(workspace, "istanbul")).toEqual(["i-2"]);
		expect(await found(workspace, "İSTANBUL")).toEqual(["i-2"]);
	});

	it("ranks title matches above description, and description above comments", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "in-comment", "Invoices");
		await admin.apply({
			name: "comment.create",
			args: { id: "c-1", issueId: "in-comment", body: "Related to billing" },
		});
		await issue(admin, "in-description", "Invoices again", "A billing question");
		await issue(admin, "in-title", "Billing page");

		expect(await found(workspace, "billing")).toEqual(["in-title", "in-description", "in-comment"]);
	});

	it("treats query syntax as plain words", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "i-1", "Fix the login form");

		for (const text of [
			'"',
			"*",
			"title:fix",
			"fix OR nothing",
			"NEAR(fix login)",
			"-fix",
			"^fix",
		]) {
			await expect(workspace.issues({ text, limit: 10 }), text).resolves.toBeDefined();
		}
		expect(await found(workspace, "title:fix")).toEqual([]);
		expect(await found(workspace, "^fix")).toEqual(["i-1"]);
		expect(await found(workspace, "?!")).toEqual([]);
	});

	it("keeps up with edits, comments, deletes and team keys", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "i-1", "Original wording");
		const update = async (patch: IssuePatch) => {
			const { version } = await issueOf(admin, "i-1");
			await admin.apply({ name: "issue.update", args: { id: "i-1", baseVersion: version, patch } });
		};

		await update({ title: "Better wording", description: "Now with details" });
		expect(await found(workspace, "original")).toEqual([]);
		expect(await found(workspace, "better details")).toEqual(["i-1"]);

		await admin.apply({
			name: "comment.create",
			args: { id: "c-1", issueId: "i-1", body: "First thought" },
		});
		expect(await found(workspace, "thought")).toEqual(["i-1"]);
		await admin.apply({ name: "comment.update", args: { id: "c-1", body: "Second idea" } });
		expect(await found(workspace, "thought")).toEqual([]);
		expect(await found(workspace, "idea")).toEqual(["i-1"]);
		await admin.apply({ name: "comment.delete", args: { id: "c-1" } });
		expect(await found(workspace, "idea")).toEqual([]);

		await admin.apply({ name: "team.update", args: { id: TEAM_ID, patch: { key: "CORE" } } });
		expect(await found(workspace, "core-1")).toEqual(["i-1"]);
		expect(await found(workspace, "eng")).toEqual([]);

		await admin.apply({ name: "issue.delete", args: { id: "i-1" } });
		expect(await found(workspace, "better")).toEqual([]);
	});

	it("indexes what a workspace held before search existed", async () => {
		const { workspace, admin } = await withTeam();
		await issue(admin, "i-1", "Kept issue", "With a description");
		await admin.apply({
			name: "comment.create",
			args: { id: "c-1", issueId: "i-1", body: "A comment from before" },
		});
		await issue(admin, "i-2", "Gone issue");
		await admin.apply({ name: "issue.delete", args: { id: "i-2" } });

		// Undo migration 0003 and run the migrations again, as when an existing workspace wakes
		// up after the deploy that brings search.
		await runInDurableObject(workspace, async (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`drop table issue_search`);
			db.run(sql`drop table issue_search_docs`);
			db.run(
				sql`delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)`,
			);
			await migrate(db, migrations);
		});

		expect(await found(workspace, "kept description before eng-1")).toEqual(["i-1"]);
		expect(await found(workspace, "gone")).toEqual([]);
	});
});
