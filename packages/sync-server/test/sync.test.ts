import { runInDurableObject } from "cloudflare:test";
import {
	AGENT_CHANGE_KINDS,
	type AgentChangeKind,
	CloseCode,
	type Issue,
	type IssueRelation,
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
import type { MemberProfile, MutateResult } from "../src";
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
				data: { ...owner, proposes: [], removedAt: null },
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

	it("keeps an issue's dates and estimate, and refuses days that do not exist", async () => {
		const { admin } = await withTeam();
		const bare = await createIssue(admin, "issue-1");
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: TEAM_ID,
				title: "Launch",
				sortOrder: "a1",
				startDate: "2026-11-02",
				dueDate: "2028-02-29",
				estimate: 0,
			},
		});
		const dated = await issueOf(admin, "issue-2");
		const update = (patch: Record<string, unknown>) =>
			admin.mutate({
				name: "issue.update",
				args: { id: dated.id, baseVersion: dated.version, patch },
			} as MutationInput);

		expect(bare).toMatchObject({ startDate: null, dueDate: null, estimate: null });
		expect(dated).toMatchObject({ startDate: "2026-11-02", dueDate: "2028-02-29", estimate: 0 });
		for (const dueDate of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-5", "tomorrow"]) {
			expect(await update({ dueDate })).toMatchObject({ type: "reject", reason: "invalid" });
		}
		for (const estimate of [-1, 1.5, 1001, "3"]) {
			expect(await update({ estimate })).toMatchObject({ type: "reject", reason: "invalid" });
		}
		expect(await update({ startDate: null, dueDate: "2026-12-01", estimate: 1000 })).toMatchObject({
			type: "ack",
		});
		expect(await issueOf(admin, dated.id)).toMatchObject({
			startDate: null,
			dueDate: "2026-12-01",
			estimate: 1000,
		});
	});

	it("puts an issue under a parent in any team, and refuses loops", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "team.create",
			args: { id: "team-des", key: "DES", name: "Design" },
		});
		const launch = await createIssue(admin, "issue-1", "Launch");
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: "team-des",
				title: "Logo",
				sortOrder: "a1",
				parentId: launch.id,
			},
		});
		const logo = await issueOf(admin, "issue-2");
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-3", teamId: TEAM_ID, title: "Sketch", sortOrder: "a2", parentId: logo.id },
		});
		const parentOf = (id: string, parentId: string | null) =>
			admin.mutate({
				name: "issue.update",
				args: { id, baseVersion: 0, patch: { parentId } },
			});

		expect(logo.parentId).toBe(launch.id);
		expect(await parentOf(launch.id, launch.id)).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(await parentOf(launch.id, logo.id)).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await parentOf(launch.id, "issue-3")).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(await parentOf(launch.id, "issue-nope")).toMatchObject({ reason: "not_found" });
		expect(
			await admin.mutate({
				name: "issue.create",
				args: {
					id: "issue-4",
					teamId: TEAM_ID,
					title: "x",
					sortOrder: "a3",
					parentId: "issue-nope",
				},
			}),
		).toMatchObject({ type: "reject", reason: "not_found" });
		expect((await workspace.issues({ parentId: launch.id, limit: 10 })).map((i) => i.id)).toEqual([
			"issue-2",
		]);

		// Moving a sub-issue up the tree is fine, and so is making it top-level.
		expect(await parentOf("issue-3", launch.id)).toMatchObject({ type: "ack" });
		expect(await parentOf("issue-3", null)).toMatchObject({ type: "ack" });
		expect((await issueOf(admin, "issue-3")).parentId).toBeNull();
	});

	it("keeps sub-issues when their parent is deleted, as top-level issues", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		const parent = await createIssue(admin, "issue-1", "Launch");
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-2", teamId: TEAM_ID, title: "Post", sortOrder: "a1", parentId: parent.id },
		});
		await viewer.op((op) => op.entity === "issue" && op.id === "issue-2");

		await admin.apply({ name: "issue.delete", args: { id: parent.id } });

		const freed = await viewer.op(
			(op) =>
				op.entity === "issue" &&
				op.id === "issue-2" &&
				op.op === "put" &&
				op.data.parentId === null,
		);
		const deleted = await viewer.op((op) => op.entity === "issue" && op.op === "delete");
		expect(freed.version).toBeLessThan(deleted.version);
		expect(await workspace.issue("issue-2")).toMatchObject({ parentId: null });
		expect(
			await admin.mutate({
				name: "issue.update",
				args: { id: "issue-2", baseVersion: 0, patch: { parentId: parent.id } },
			}),
		).toMatchObject({ type: "reject", reason: "not_found" });
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

describe("relations", () => {
	function relate(
		client: TestClient,
		id: string,
		type: IssueRelation["type"],
		issueId: string,
		relatedIssueId: string,
	) {
		return client.mutate({ name: "relation.create", args: { id, type, issueId, relatedIssueId } });
	}

	async function relationsOf(workspace: Workspace) {
		const { relations } = await snapshotOf(workspace);
		return relations.map(({ id, type, issueId, relatedIssueId }) => ({
			id,
			type,
			issueId,
			relatedIssueId,
		}));
	}

	it("relates issues in any team, one relation per pair, which a new one replaces", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "team.create",
			args: { id: "team-des", key: "DES", name: "Design" },
		});
		const api = await createIssue(admin, "issue-1", "API");
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-2", teamId: "team-des", title: "Mockups", sortOrder: "a1" },
		});
		const mockups = await issueOf(admin, "issue-2");

		expect(await relate(admin, "rel-1", "blocks", mockups.id, api.id)).toMatchObject({
			type: "ack",
		});
		expect(await relationsOf(workspace)).toEqual([
			{ id: "rel-1", type: "blocks", issueId: mockups.id, relatedIssueId: api.id },
		]);
		expect((await snapshotOf(workspace)).relations[0]).toMatchObject({ creatorId: owner.id });

		expect(await relate(admin, "rel-x", "related", api.id, api.id)).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(await relate(admin, "rel-x", "related", api.id, "issue-nope")).toMatchObject({
			type: "reject",
			reason: "not_found",
		});
		expect(await relate(admin, "rel-1", "related", api.id, mockups.id)).toMatchObject({
			type: "reject",
			reason: "invalid",
		});

		// The relation the pair already has is a no-op; another kind takes its place.
		expect(await relate(admin, "rel-2", "blocks", mockups.id, api.id)).toMatchObject({
			type: "ack",
		});
		expect((await relationsOf(workspace)).map(({ id }) => id)).toEqual(["rel-1"]);
		await relate(admin, "rel-3", "blocks", api.id, mockups.id);
		expect(await relationsOf(workspace)).toEqual([
			{ id: "rel-3", type: "blocks", issueId: api.id, relatedIssueId: mockups.id },
		]);
		expect((await workspace.relations(mockups.id)).map(({ id }) => id)).toEqual(["rel-3"]);

		expect(await admin.mutate({ name: "relation.delete", args: { id: "rel-3" } })).toMatchObject({
			type: "ack",
		});
		expect(await relationsOf(workspace)).toEqual([]);
		expect(await admin.mutate({ name: "relation.delete", args: { id: "rel-3" } })).toMatchObject({
			type: "reject",
			reason: "not_found",
		});
	});

	it("removes an issue's relations when it is deleted", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		const blocker = await createIssue(admin, "issue-1", "Blocker");
		const blocked = await createIssue(admin, "issue-2", "Blocked");
		await relate(admin, "rel-1", "blocks", blocker.id, blocked.id);
		await viewer.op((op) => op.entity === "relation" && op.id === "rel-1");

		await admin.apply({ name: "issue.delete", args: { id: blocker.id } });

		const gone = await viewer.op((op) => op.entity === "relation" && op.op === "delete");
		const deleted = await viewer.op((op) => op.entity === "issue" && op.op === "delete");
		expect(gone.version).toBeLessThan(deleted.version);
		expect(await relationsOf(workspace)).toEqual([]);
		expect(await workspace.relations(blocked.id)).toEqual([]);
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

describe("projects", () => {
	const agent: MemberProfile = { ...owner, id: "user-bot", name: "Bot", role: "agent" };
	const AGENT = "mcp:test-agent";

	async function createProject(client: TestClient, id: string, name = "Launch") {
		await client.apply({ name: "project.create", args: { id, name } });
	}

	async function projectsOf(workspace: Workspace) {
		return (await snapshotOf(workspace)).projects;
	}

	it("creates, updates and deletes projects, and tells other clients", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);

		await admin.apply({
			name: "project.create",
			args: { id: "project-1", name: "  Launch  ", description: "Ship it", leadId: alice.id },
		});
		const created = await viewer.op((op) => op.entity === "project" && op.op === "put");
		expect(created).toMatchObject({
			id: "project-1",
			data: {
				name: "Launch",
				description: "Ship it",
				status: "planned",
				leadId: alice.id,
				targetDate: null,
			},
		});

		// Any person can change a project, not only an admin.
		const member = await TestClient.live(workspace, alice);
		await member.apply({
			name: "project.update",
			args: {
				id: "project-1",
				patch: { status: "started", targetDate: "2028-02-29", leadId: null, description: null },
			},
		});
		expect((await projectsOf(workspace))[0]).toMatchObject({
			status: "started",
			targetDate: "2028-02-29",
			leadId: null,
			description: null,
		});

		await admin.apply({ name: "project.delete", args: { id: "project-1" } });
		expect(await viewer.op((op) => op.entity === "project" && op.op === "delete")).toMatchObject({
			id: "project-1",
		});
		expect(await projectsOf(workspace)).toEqual([]);
		// The row stays, as labels do.
		await runInDurableObject(workspace, (_, state) => {
			const rows = drizzle(state.storage, { schema }).select().from(schema.projects).all();
			expect(rows).toMatchObject([{ id: "project-1", deletedAt: expect.any(Number) }]);
		});
	});

	it("does not write when an update changes nothing", async () => {
		const { workspace, admin } = await withTeam();
		await createProject(admin, "project-1");
		const head = (await snapshotOf(workspace)).version;

		const result = await admin.apply({
			name: "project.update",
			args: { id: "project-1", patch: { name: "Launch", status: "planned" } },
		});

		expect(result.version).toBe(head);
	});

	it("sets a project on issues, at creation and after", async () => {
		const { workspace, admin } = await withTeam();
		await createProject(admin, "project-1");
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: TEAM_ID,
				title: "In",
				projectId: "project-1",
				sortOrder: "a0",
			},
		});
		const loose = await createIssue(admin, "issue-2");

		await admin.apply({
			name: "issue.update",
			args: { id: loose.id, baseVersion: loose.version, patch: { projectId: "project-1" } },
		});

		expect((await issueOf(admin, "issue-1")).projectId).toBe("project-1");
		expect((await issueOf(admin, "issue-2")).projectId).toBe("project-1");
		expect(await createIssue(admin, "issue-3")).toMatchObject({ projectId: null });
		const found = await workspace.issues({ projectId: "project-1", limit: 10 });
		expect(found.map((issue) => issue.id).sort()).toEqual(["issue-1", "issue-2"]);
		expect((await workspace.directory()).projects).toMatchObject([
			{ id: "project-1", name: "Launch" },
		]);
	});

	it("takes the project off every issue in it when an admin deletes it", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		await createProject(admin, "project-1");
		await createProject(admin, "project-2", "Other");
		for (const [id, projectId] of [
			["issue-1", "project-1"],
			["issue-2", "project-1"],
			["issue-3", "project-2"],
		] as const) {
			await admin.apply({
				name: "issue.create",
				args: { id, teamId: TEAM_ID, title: id, projectId, sortOrder: "a0" },
			});
		}
		await issueOf(viewer, "issue-3");

		await admin.apply({ name: "project.delete", args: { id: "project-1" } });

		const cleared = (client: TestClient) =>
			client
				.ops()
				.filter((op) => op.entity === "issue" && op.op === "put" && op.data.projectId === null)
				.map((op) => op.id)
				.sort();
		await viewer.op((op) => op.entity === "project" && op.op === "delete");
		expect(cleared(viewer)).toEqual(["issue-1", "issue-2"]);
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.issues.map((issue) => [issue.id, issue.projectId]).sort()).toEqual([
			["issue-1", null],
			["issue-2", null],
			["issue-3", "project-2"],
		]);
		expect(snapshot.projects.map((project) => project.id)).toEqual(["project-2"]);
	});

	it("refuses an agent writing a project, and a member deleting one", async () => {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(agent);
		const member = await TestClient.live(workspace, alice);
		await createProject(admin, "project-1");

		const agentCreate = await workspace.mutate(agent, AGENT, "m-1", {
			name: "project.create",
			args: { id: "project-2", name: "By a bot" },
		});
		const agentUpdate = await workspace.mutate(agent, AGENT, "m-2", {
			name: "project.update",
			args: { id: "project-1", patch: { name: "Renamed by a bot" } },
		});
		const agentDelete = await workspace.mutate(agent, AGENT, "m-3", {
			name: "project.delete",
			args: { id: "project-1" },
		});
		const memberDelete = await member.mutate({ name: "project.delete", args: { id: "project-1" } });

		expect(agentCreate).toMatchObject({ ok: false, reason: "forbidden" });
		expect(agentUpdate).toMatchObject({ ok: false, reason: "forbidden" });
		expect(agentDelete).toMatchObject({ ok: false, reason: "forbidden" });
		expect(memberDelete).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(await projectsOf(workspace)).toMatchObject([{ id: "project-1", name: "Launch" }]);
	});

	it("lets only people lead a project", async () => {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(alice);
		await workspace.syncMember(agent);
		await workspace.syncMember(bob);
		await workspace.removeMember(bob.id);
		await createProject(admin, "project-1");

		const lead = (leadId: string) =>
			admin.mutate({ name: "project.update", args: { id: "project-1", patch: { leadId } } });

		expect(await lead("user-nobody")).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await lead(agent.id)).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await lead(bob.id)).toMatchObject({ type: "reject", reason: "invalid" });
		expect(
			await admin.mutate({
				name: "project.create",
				args: { id: "project-2", name: "Led by a bot", leadId: agent.id },
			}),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await lead(alice.id)).toMatchObject({ type: "ack" });
		expect((await projectsOf(workspace))[0]?.leadId).toBe(alice.id);
	});

	it("refuses invalid names, dates, ids and projects that are gone", async () => {
		const { admin } = await withTeam();
		await createProject(admin, "project-1");
		const issue = await createIssue(admin, "issue-1");
		const update = (patch: Record<string, unknown>) =>
			admin.mutate({ name: "project.update", args: { id: "project-1", patch } } as MutationInput);

		expect(await update({ name: "   " })).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await update({ name: "x".repeat(65) })).toMatchObject({ reason: "invalid" });
		expect(await update({})).toMatchObject({ type: "reject", reason: "invalid" });
		expect(await update({ status: "finished" })).toMatchObject({ reason: "invalid" });
		for (const targetDate of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-5", "tomorrow"]) {
			expect(await update({ targetDate })).toMatchObject({ type: "reject", reason: "invalid" });
		}
		expect(await update({ targetDate: "2028-02-29" })).toMatchObject({ type: "ack" });
		expect(await update({ targetDate: null })).toMatchObject({ type: "ack" });
		expect(
			await admin.mutate({ name: "project.create", args: { id: "project-1", name: "Again" } }),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect(
			await admin.mutate({
				name: "project.update",
				args: { id: "project-9", patch: { name: "Nope" } },
			}),
		).toMatchObject({ type: "reject", reason: "not_found" });
		expect(await admin.mutate({ name: "project.delete", args: { id: "project-9" } })).toMatchObject(
			{ type: "reject", reason: "not_found" },
		);

		// An issue refuses a project that does not exist, or no longer does.
		await admin.apply({ name: "project.delete", args: { id: "project-1" } });
		const toDeleted = await admin.mutate({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-1" } },
		});
		const toMissing = await admin.mutate({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-9" } },
		});
		const created = await admin.mutate({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: TEAM_ID,
				title: "Late",
				projectId: "project-1",
				sortOrder: "a1",
			},
		});
		expect(toDeleted).toMatchObject({ type: "reject", reason: "not_found" });
		expect(toMissing).toMatchObject({ type: "reject", reason: "not_found" });
		expect(created).toMatchObject({ type: "reject", reason: "not_found" });
		expect((await issueOf(admin, issue.id)).projectId).toBeNull();
		// A rejected create must not consume an issue number.
		expect(await createIssue(admin, "issue-3")).toMatchObject({ number: 2 });
	});

	it("treats projectId like any other issue field when edits collide", async () => {
		const { workspace, admin } = await withTeam();
		await createProject(admin, "project-1");
		await createProject(admin, "project-2", "Other");
		const issue = await createIssue(admin, "issue-1");
		const a = await TestClient.live(workspace, alice);
		const b = await TestClient.live(workspace, bob);
		const move = (client: TestClient, projectId: string | null, extra = {}) =>
			client.mutate({
				name: "issue.update",
				args: { id: issue.id, baseVersion: issue.version, patch: { projectId, ...extra } },
			});

		expect(await move(a, "project-1")).toMatchObject({ type: "ack" });
		// Bob never saw Alice's edit, so his is stale for this field.
		expect(await move(b, "project-2")).toMatchObject({ type: "reject", reason: "conflict" });
		expect((await issueOf(admin, issue.id)).projectId).toBe("project-1");
		// Other fields of the same patch still land; the same client's later edits always do.
		expect(await move(a, "project-2")).toMatchObject({ type: "ack" });
		expect(await move(a, null)).toMatchObject({ type: "ack" });
		expect(await issueOf(admin, issue.id)).toMatchObject({ projectId: null });
		// And a partially stale patch applies what does not conflict.
		await a.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-1" } },
		});
		expect(await move(b, "project-2", { priority: 3 })).toMatchObject({ type: "ack" });
		expect(await issueOf(admin, issue.id)).toMatchObject({ projectId: "project-1", priority: 3 });
	});

	it("records an issue's project in its history", async () => {
		const { workspace, admin } = await withTeam();
		await createProject(admin, "project-1");
		const issue = await createIssue(admin, "issue-1");

		await admin.apply({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-1" } },
		});

		const { activities } = await snapshotOf(workspace);
		expect(activities.map((activity) => activity.change)).toEqual([
			{ type: "project", from: null, to: "project-1" },
		]);
	});

	it("leaves deleted projects out of the snapshot", async () => {
		const { workspace, admin } = await withTeam();
		await createProject(admin, "project-1");
		await createProject(admin, "project-2", "Gone");
		await admin.apply({ name: "project.delete", args: { id: "project-2" } });

		expect((await projectsOf(workspace)).map((project) => project.id)).toEqual(["project-1"]);
	});
});

describe("imports", () => {
	it("keeps the original dates an admin imports, and no later than now", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const opened = Date.UTC(2024, 2, 1, 9, 30);
		const answered = Date.UTC(2024, 2, 2, 17, 0);

		await admin.apply({
			name: "issue.create",
			args: {
				id: "imported",
				teamId: TEAM_ID,
				title: "From GitHub",
				sortOrder: "a0",
				createdAt: opened,
			},
		});
		await admin.apply({
			name: "comment.create",
			args: { id: "imported-comment", issueId: "imported", body: "Seen", createdAt: answered },
		});
		const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
		await admin.apply({
			name: "issue.create",
			args: {
				id: "skewed",
				teamId: TEAM_ID,
				title: "Clock skew",
				sortOrder: "a1",
				createdAt: future,
			},
		});

		const imported = await issueOf(admin, "imported");
		expect(imported.createdAt).toBe(opened);
		expect(imported.updatedAt).toBeGreaterThan(opened);
		expect((await issueOf(admin, "skewed")).createdAt).toBeLessThanOrEqual(Date.now());
		expect((await snapshotOf(workspace)).comments).toMatchObject([
			{ id: "imported-comment", createdAt: answered },
		]);

		// Only admins import; anyone else gets the time they write.
		const byMember = await member.mutate({
			name: "issue.create",
			args: { id: "backdated", teamId: TEAM_ID, title: "Old", sortOrder: "a2", createdAt: opened },
		});
		const commentByMember = await member.mutate({
			name: "comment.create",
			args: { id: "backdated-comment", issueId: "imported", body: "Old", createdAt: answered },
		});
		expect(byMember).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(commentByMember).toMatchObject({ type: "reject", reason: "forbidden" });
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

	it("records a change of parent", async () => {
		const { workspace, admin } = await withTeam();
		const parent = await createIssue(admin, "issue-1", "Launch");
		const issue = await createIssue(admin, "issue-2", "Post");

		await update(admin, issue.id, { parentId: parent.id });

		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: owner.id, change: { type: "parent", from: null, to: parent.id } },
		]);
	});

	it("records a relation on both issues, each from its own side", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const a = await createIssue(admin, "issue-1", "A");
		const b = await createIssue(admin, "issue-2", "B");
		const relate = (client: TestClient, id: string, type: IssueRelation["type"]) =>
			client.apply({
				name: "relation.create",
				args: { id, type, issueId: a.id, relatedIssueId: b.id },
			});

		await relate(member, "rel-1", "duplicate");
		expect(await historyOf(workspace, a.id)).toEqual([
			{
				actorId: alice.id,
				change: { type: "relation", kind: "duplicate_of", issueId: b.id, added: true },
			},
		]);
		expect(await historyOf(workspace, b.id)).toEqual([
			{
				actorId: alice.id,
				change: { type: "relation", kind: "duplicated_by", issueId: a.id, added: true },
			},
		]);

		// Changing your mind straight away leaves only where you ended up.
		await relate(member, "rel-2", "blocks");
		expect(await historyOf(workspace, b.id)).toEqual([
			{
				actorId: alice.id,
				change: { type: "relation", kind: "blocked_by", issueId: a.id, added: true },
			},
		]);
		await member.apply({ name: "relation.delete", args: { id: "rel-2" } });
		expect(await historyOf(workspace, a.id)).toEqual([]);

		// Someone else removing it is a change of its own.
		await relate(member, "rel-3", "related");
		await admin.apply({ name: "relation.delete", args: { id: "rel-3" } });
		expect(
			(await historyOf(workspace, b.id)).map(({ actorId, change }) => [actorId, change]),
		).toEqual([
			[alice.id, { type: "relation", kind: "related", issueId: a.id, added: true }],
			[owner.id, { type: "relation", kind: "related", issueId: a.id, added: false }],
		]);
	});

	it("records dates and estimates, merging quick changes", async () => {
		const { workspace, admin } = await withTeam();
		const issue = await createIssue(admin, "issue-1");

		await update(admin, issue.id, { startDate: "2026-11-02" });
		await update(admin, issue.id, { dueDate: "2026-11-20" });
		await update(admin, issue.id, { dueDate: "2026-11-27" });
		await update(admin, issue.id, { estimate: 3 });
		await update(admin, issue.id, { estimate: 5 });

		expect(await historyOf(workspace, issue.id)).toEqual([
			{ actorId: owner.id, change: { type: "startDate", from: null, to: "2026-11-02" } },
			{ actorId: owner.id, change: { type: "dueDate", from: null, to: "2026-11-27" } },
			{ actorId: owner.id, change: { type: "estimate", from: null, to: 5 } },
		]);

		await update(admin, issue.id, { estimate: null });
		expect((await historyOf(workspace, issue.id)).map(({ change }) => change.type)).toEqual([
			"startDate",
			"dueDate",
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

		expect(result).toEqual({ ok: true, version: expect.any(Number), proposed: [] });
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

	it("lets an agent member do what a member can, and nothing an admin can", async () => {
		const { workspace, admin } = await withTeam();
		const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
		await createIssue(admin, "issue-1");
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-1", body: "Looks like a duplicate" },
		});

		const filed = await workspace.mutate(triage, AGENT, "m-1", {
			name: "issue.create",
			args: { id: "issue-2", teamId: TEAM_ID, title: "Filed by triage", sortOrder: "a1" },
		});
		const team = await workspace.mutate(triage, AGENT, "m-2", {
			name: "team.create",
			args: { id: "team-2", key: "OPS", name: "Operations" },
		});
		const comment = await workspace.mutate(triage, AGENT, "m-3", {
			name: "comment.delete",
			args: { id: "comment-1" },
		});

		expect(filed).toEqual({ ok: true, version: expect.any(Number), proposed: [] });
		expect(await issueOf(admin, "issue-2")).toMatchObject({ creatorId: triage.id });
		expect(team).toMatchObject({ ok: false, reason: "forbidden" });
		expect(comment).toMatchObject({ ok: false, reason: "forbidden" });
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

describe("proposals", () => {
	const AGENT = "mcp:test-agent";
	const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };

	/** A workspace with an issue, a Bug label, and Triage set to propose `proposes`. */
	async function withAgent(proposes: AgentChangeKind[]) {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(triage);
		await workspace.syncMember(alice);
		await admin.apply({
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#e5484d" },
		});
		const issue = await createIssue(admin, "issue-1");
		await admin.apply({ name: "agent.update", args: { id: triage.id, patch: { proposes } } });
		let n = 0;
		const asTriage = (mutation: MutationInput) =>
			workspace.mutate(triage, AGENT, `m-${++n}`, mutation);
		const setStatus = (status: Issue["status"]) =>
			asTriage({
				name: "issue.update",
				args: { id: issue.id, baseVersion: issue.version, patch: { status } },
			});
		return { workspace, admin, issue, asTriage, setStatus };
	}

	function proposed(result: MutateResult) {
		if (!result.ok) throw new Error(`Expected the mutation to apply: ${result.message}`);
		return result.proposed;
	}

	async function openProposals(workspace: Workspace) {
		const { proposals } = await snapshotOf(workspace);
		return proposals.map(({ agentId, change }) => ({ agentId, change }));
	}

	it("makes what an agent may make, and proposes the rest", async () => {
		const { workspace, admin, issue, asTriage } = await withAgent(["status", "assignee", "labels"]);

		const update = await asTriage({
			name: "issue.update",
			args: {
				id: issue.id,
				baseVersion: issue.version,
				patch: { priority: 2, status: "todo", assigneeId: alice.id },
			},
		});
		const label = await asTriage({
			name: "issue.addLabel",
			args: { id: issue.id, labelId: "label-bug" },
		});

		expect(proposed(update).map((proposal) => proposal.change)).toEqual([
			{ type: "status", to: "todo" },
			{ type: "assignee", to: alice.id },
		]);
		expect(proposed(label)).toMatchObject([
			{ agentId: triage.id, issueId: issue.id, change: { type: "label", labelId: "label-bug" } },
		]);
		expect(await workspace.issue(issue.id)).toMatchObject({
			priority: 2,
			status: "backlog",
			assigneeId: null,
			labelIds: [],
		});
		const open = await openProposals(workspace);
		expect(open).toHaveLength(3);
		expect(open).toEqual(
			expect.arrayContaining([
				{ agentId: triage.id, change: { type: "status", to: "todo" } },
				{ agentId: triage.id, change: { type: "assignee", to: alice.id } },
				{ agentId: triage.id, change: { type: "label", labelId: "label-bug", added: true } },
			]),
		);
		expect(await workspace.proposals(issue.id)).toHaveLength(3);
		// People see them as they are made.
		await admin.op((op) => op.entity === "proposal" && op.op === "put");
	});

	it("makes an agent's parent, dates and estimates at once, whatever it is set to propose", async () => {
		const { workspace, admin, issue, asTriage } = await withAgent([...AGENT_CHANGE_KINDS]);
		const parent = await createIssue(admin, "issue-parent", "Launch");

		const result = await asTriage({
			name: "issue.update",
			args: {
				id: issue.id,
				baseVersion: issue.version,
				patch: { parentId: parent.id, startDate: "2026-11-02", dueDate: "2026-11-20", estimate: 8 },
			},
		});

		expect(proposed(result)).toEqual([]);
		expect(await workspace.issue(issue.id)).toMatchObject({
			parentId: parent.id,
			startDate: "2026-11-02",
			dueDate: "2026-11-20",
			estimate: 8,
		});
	});

	it("relates an agent's issues at once, whatever it is set to propose", async () => {
		const { workspace, admin, issue, asTriage } = await withAgent([...AGENT_CHANGE_KINDS]);
		const other = await createIssue(admin, "issue-other", "Other");

		const result = await asTriage({
			name: "relation.create",
			args: { id: "rel-1", type: "blocks", issueId: issue.id, relatedIssueId: other.id },
		});

		expect(proposed(result)).toEqual([]);
		expect(await workspace.relations(issue.id)).toMatchObject([
			{ id: "rel-1", creatorId: triage.id },
		]);
	});

	it("proposes only closing when that is what it is set to propose", async () => {
		const { workspace, issue, setStatus } = await withAgent(["close"]);

		const start = await setStatus("in_progress");
		const close = await setStatus("done");

		expect(proposed(start)).toEqual([]);
		expect(proposed(close).map((proposal) => proposal.change)).toEqual([
			{ type: "status", to: "done" },
		]);
		expect(await workspace.issue(issue.id)).toMatchObject({ status: "in_progress" });
	});

	it("makes an agent's new issue without what it proposes, then proposes that on it", async () => {
		const { workspace, asTriage } = await withAgent(["close", "assignee", "labels"]);

		const created = await asTriage({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: TEAM_ID,
				title: "Filed by triage",
				status: "done",
				priority: 1,
				assigneeId: alice.id,
				labelIds: ["label-bug"],
				sortOrder: "a1",
			},
		});
		const open = await asTriage({
			name: "issue.create",
			args: {
				id: "issue-3",
				teamId: TEAM_ID,
				title: "Still open",
				status: "todo",
				sortOrder: "a2",
			},
		});

		expect(proposed(created).map((proposal) => proposal.change)).toEqual([
			{ type: "status", to: "done" },
			{ type: "assignee", to: alice.id },
			{ type: "label", labelId: "label-bug", added: true },
		]);
		expect(await workspace.issue("issue-2")).toMatchObject({
			title: "Filed by triage",
			status: "backlog",
			priority: 1,
			assigneeId: null,
			labelIds: [],
		});
		expect(proposed(open)).toEqual([]);
		expect(await workspace.issue("issue-3")).toMatchObject({ status: "todo" });
	});

	it("proposes a project change when an admin chose the project kind, and applies it on accept", async () => {
		const { workspace, admin, issue, asTriage } = await withAgent(["project"]);
		await admin.apply({ name: "project.create", args: { id: "project-1", name: "Launch" } });

		const update = await asTriage({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-1" } },
		});
		const [proposal] = proposed(update);
		const created = await asTriage({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: TEAM_ID,
				title: "Filed by triage",
				projectId: "project-1",
				sortOrder: "a1",
			},
		});

		expect(proposal?.change).toEqual({ type: "project", to: "project-1" });
		expect(proposed(created).map((p) => p.change)).toEqual([{ type: "project", to: "project-1" }]);
		expect(await workspace.issue(issue.id)).toMatchObject({ projectId: null });
		expect(await workspace.issue("issue-2")).toMatchObject({ projectId: null });
		expect(await openProposals(workspace)).toHaveLength(2);

		const member = await TestClient.live(workspace, alice);
		await member.apply({ name: "proposal.accept", args: { id: proposal?.id ?? "" } });

		expect(await workspace.issue(issue.id)).toMatchObject({ projectId: "project-1" });
		const { activities } = await snapshotOf(workspace);
		expect(
			activities.map(({ actorId, change, proposedBy }) => ({ actorId, change, proposedBy })),
		).toEqual([
			{
				actorId: alice.id,
				change: { type: "project", from: null, to: "project-1" },
				proposedBy: triage.id,
			},
		]);
		expect(await openProposals(workspace)).toHaveLength(1);
	});

	it("makes a project change at once when the agent is not set to propose it", async () => {
		const { workspace, admin, issue, asTriage } = await withAgent(["priority"]);
		await admin.apply({ name: "project.create", args: { id: "project-1", name: "Launch" } });

		const update = await asTriage({
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch: { projectId: "project-1" } },
		});

		expect(proposed(update)).toEqual([]);
		expect(await workspace.issue(issue.id)).toMatchObject({ projectId: "project-1" });
	});

	it("replaces an agent's proposal for a field, and withdraws it once nothing needs to change", async () => {
		const { workspace, setStatus } = await withAgent(["status"]);

		const [first] = proposed(await setStatus("done"));
		const [second] = proposed(await setStatus("canceled"));
		const [same] = proposed(await setStatus("canceled"));

		expect(second?.id).toBe(first?.id);
		expect(same).toMatchObject({ id: first?.id, change: { type: "status", to: "canceled" } });
		expect(await openProposals(workspace)).toEqual([
			{ agentId: triage.id, change: { type: "status", to: "canceled" } },
		]);

		// Backlog is what the issue has, so the agent no longer proposes anything.
		expect(proposed(await setStatus("backlog"))).toEqual([]);
		expect(await openProposals(workspace)).toEqual([]);
	});

	it("makes an accepted change as the person, with the agent in the history", async () => {
		const { workspace, admin, issue, asTriage, setStatus } = await withAgent(["status", "labels"]);
		const [status] = proposed(await setStatus("done"));
		const [label] = proposed(
			await asTriage({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-bug" } }),
		);
		if (!status || !label) throw new Error("Expected two proposals");
		const member = await TestClient.live(workspace, alice);

		await member.apply({ name: "proposal.accept", args: { id: status.id } });
		await member.apply({ name: "proposal.accept", args: { id: label.id } });

		expect(await workspace.issue(issue.id)).toMatchObject({
			status: "done",
			labelIds: ["label-bug"],
		});
		const { activities, proposals } = await snapshotOf(workspace);
		expect(
			activities.map(({ actorId, change, proposedBy }) => ({ actorId, change, proposedBy })),
		).toEqual([
			{
				actorId: alice.id,
				change: { type: "status", from: "backlog", to: "done" },
				proposedBy: triage.id,
			},
			{
				actorId: alice.id,
				change: { type: "label", labelId: "label-bug", added: true },
				proposedBy: triage.id,
			},
		]);
		expect(proposals).toEqual([]);
		await admin.op((op) => op.entity === "proposal" && op.id === status.id && op.op === "delete");
		// Decided proposals keep their row, as the record of who decided.
		await runInDurableObject(workspace, (_, state) => {
			const rows = drizzle(state.storage, { schema }).select().from(schema.proposals).all();
			expect(rows.map(({ status, decidedBy }) => ({ status, decidedBy }))).toEqual([
				{ status: "accepted", decidedBy: alice.id },
				{ status: "accepted", decidedBy: alice.id },
			]);
		});
	});

	it("leaves the issue as it was when a person dismisses a proposal, and no agent decides", async () => {
		const { workspace, issue, asTriage } = await withAgent(["priority"]);
		const [proposal] = proposed(
			await asTriage({
				name: "issue.update",
				args: { id: issue.id, baseVersion: issue.version, patch: { priority: 1 } },
			}),
		);
		if (!proposal) throw new Error("Expected a proposal");

		const accepted = await asTriage({ name: "proposal.accept", args: { id: proposal.id } });
		const dismissed = await asTriage({ name: "proposal.dismiss", args: { id: proposal.id } });
		expect(accepted).toMatchObject({ ok: false, reason: "forbidden" });
		expect(dismissed).toMatchObject({ ok: false, reason: "forbidden" });

		const member = await TestClient.live(workspace, alice);
		await member.apply({ name: "proposal.dismiss", args: { id: proposal.id } });
		const late = await member.mutate({ name: "proposal.accept", args: { id: proposal.id } });

		expect(late).toMatchObject({ type: "reject", reason: "not_found" });
		expect(await workspace.issue(issue.id)).toMatchObject({ priority: 0 });
		const { activities, proposals } = await snapshotOf(workspace);
		expect(activities).toEqual([]);
		expect(proposals).toEqual([]);
	});

	it("drops a deleted issue's proposals", async () => {
		const { workspace, admin, issue, setStatus } = await withAgent(["status"]);
		const [proposal] = proposed(await setStatus("done"));
		if (!proposal) throw new Error("Expected a proposal");

		await admin.apply({ name: "issue.delete", args: { id: issue.id } });

		await admin.op((op) => op.entity === "proposal" && op.id === proposal.id && op.op === "delete");
		expect((await snapshotOf(workspace)).proposals).toEqual([]);
		const late = await admin.mutate({ name: "proposal.accept", args: { id: proposal.id } });
		expect(late).toMatchObject({ type: "reject", reason: "not_found" });
	});

	it("lets only admins set what an agent proposes, and only for agents", async () => {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(triage);
		const member = await TestClient.live(workspace, alice);
		const setting = (id: string): MutationInput => ({
			name: "agent.update",
			args: { id, patch: { proposes: ["status"] } },
		});

		expect(await member.mutate(setting(triage.id))).toMatchObject({ reason: "forbidden" });
		expect(await admin.mutate(setting(alice.id))).toMatchObject({ reason: "not_found" });
		await admin.apply({
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["labels", "status", "labels"] } },
		});
		// The app worker pushes membership, and leaves the workspace's own setting alone.
		await workspace.syncMember({ ...triage, name: "Triage bot" });

		const { members } = await snapshotOf(workspace);
		expect(members.find((m) => m.id === triage.id)).toMatchObject({
			name: "Triage bot",
			proposes: ["status", "labels"],
		});
		expect(members.find((m) => m.id === alice.id)?.proposes).toEqual([]);
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

		// Undo migration 0003 and those after it, then run the migrations again, as when an
		// existing workspace wakes up after the deploy that brings search.
		const search = migrations.journal.entries.find((entry) => entry.tag === "0003_issue_search");
		if (!search) throw new Error("No search migration");
		await runInDurableObject(workspace, async (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`drop table relations`);
			db.run(sql`drop index issues_project_idx`);
			db.run(sql`alter table issues drop column project_id`);
			db.run(sql`drop table projects`);
			db.run(sql`drop table issue_search`);
			db.run(sql`drop table issue_search_docs`);
			db.run(sql`drop table webhook_deliveries`);
			db.run(sql`drop table webhooks`);
			db.run(sql`drop table proposals`);
			db.run(sql`alter table activities drop column proposed_by`);
			db.run(sql`alter table members drop column proposes`);
			db.run(sql`alter table issues drop column start_date`);
			db.run(sql`alter table issues drop column due_date`);
			db.run(sql`alter table issues drop column estimate`);
			db.run(sql`drop index issues_parent_idx`);
			db.run(sql`alter table issues drop column parent_id`);
			db.run(sql`delete from __drizzle_migrations where created_at >= ${search.when}`);
			await migrate(db, migrations);
		});

		expect(await found(workspace, "kept description before eng-1")).toEqual(["i-1"]);
		expect(await found(workspace, "gone")).toEqual([]);
	});
});
