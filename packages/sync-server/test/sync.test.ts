import { runInDurableObject } from "cloudflare:test";
import {
	type ActiveIssue,
	AGENT_CHANGE_KINDS,
	type AgentChangeKind,
	ARCHIVE_PAGE_SIZE,
	CloseCode,
	type IssueRelation,
	isActiveIssue,
	MAX_LABELS_PER_ISSUE,
	MAX_VIEWS,
	type MutationInput,
	type Op,
	PING,
	PONG,
	type SyncedIssue,
} from "@gateweave/track-protocol";
import { type Column, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it } from "vitest";
import migrations from "../drizzle/migrations";
import type { MemberProfile, MutateResult } from "../src";
import { ARCHIVE_ROW_ALLOWANCE, archiveSize } from "../src/archive";
import * as schema from "../src/db/schema";
import { compact } from "../src/log";
import {
	freshWorkspace,
	SESSION,
	storedHistory,
	TestClient,
	type Workspace,
	whole,
} from "./client";

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

/**
 * The bytes `row` comes to in JSON besides its text and JSON columns, with its numbers at their
 * widest and its flags `false`: what the whole archive's size allows each row of its kind.
 */
function overhead(row: object, columns: Record<string, Column>): number {
	const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
	let text = 0;
	const widest = Object.entries(row).map(([key, value]) => {
		const column = columns[key];
		if (!column) throw new Error(`No column for ${key}`);
		if (column.dataType === "number") return [key, Number.MAX_SAFE_INTEGER];
		if (column.dataType === "boolean") return [key, false];
		text += bytes(value);
		return [key, value];
	});
	return bytes(Object.fromEntries(widest)) - text;
}

/**
 * At least the bytes V8's serializer, which structured clone uses, writes for `value`: a string
 * in one byte a character when every one fits, else two bytes a UTF-16 unit, after a tag and its
 * length; every number as a double.
 */
function cloneBytes(value: unknown): number {
	const varint = (n: number) => Math.max(1, Math.ceil(Math.log2(n + 1) / 7));
	if (value === null || value === undefined || typeof value === "boolean") return 1;
	if (typeof value === "number") return 9;
	if (typeof value === "string") {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is a one-byte character too.
		const wide = /[^\u0000-\u00ff]/.test(value);
		const size = wide ? 2 * value.length : value.length;
		// A two-byte string may be padded by a byte, to align it.
		return 1 + varint(size) + size + (wide ? 1 : 0);
	}
	if (Array.isArray(value)) {
		return 11 + value.reduce((total: number, each) => total + cloneBytes(each), 0);
	}
	if (typeof value === "object") {
		const entries = Object.entries(value);
		return (
			7 + entries.reduce((total, [key, each]) => total + cloneBytes(key) + cloneBytes(each), 0)
		);
	}
	throw new Error(`Not cloned: ${typeof value}`);
}

/** Latest state of an issue that is not archived, as seen by `client`. */
async function issueOf(client: TestClient, id: string): Promise<ActiveIssue> {
	return whole(await rowOf(client, id));
}

/** Latest state of an issue as seen by `client`: whole, or an archived issue's slim row. */
async function rowOf(client: TestClient, id: string): Promise<SyncedIssue> {
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
			headers: {
				Upgrade: "websocket",
				"x-track-member": JSON.stringify(owner),
				"x-track-session": JSON.stringify(SESSION),
			},
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
		(await TestClient.live(workspace, alice)).close();
		const issue = await createIssue(admin, "issue-1");

		const returning = await TestClient.connect(workspace, alice);
		const ready = await returning.hello(issue.version - 1);

		// Creating the issue also subscribed its creator, which only the creator hears of.
		expect(ready).toEqual({ type: "ready", version: issue.version + 1 });
		expect(returning.ops().map((op) => op.version)).toEqual([issue.version]);
		expect(returning.through).toBe(issue.version + 1);
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

describe("archive", () => {
	async function update(client: TestClient, id: string, patch: IssuePatch) {
		const row = await rowOf(client, id);
		// An archived issue's slim row has no version: the client has seen all it was sent.
		const baseVersion = isActiveIssue(row) ? row.version : (client.through ?? 0);
		return client.apply({ name: "issue.update", args: { id, baseVersion, patch } });
	}
	const archive = (client: TestClient, id: string, archived: boolean) =>
		client.mutate({ name: "issue.archive", args: { id, archived } });

	// Replicas do not hold an archived issue's history, so this reads what the workspace stores.
	async function historyOf(workspace: Workspace, issueId: string) {
		return (await storedHistory(workspace, issueId)).map(({ actorId, change }) => ({
			actorId,
			change,
		}));
	}

	it("archives a closed issue for everyone, refuses an open one, and restores it", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");

		expect(await archive(admin, issue.id, true)).toMatchObject({
			type: "reject",
			reason: "invalid",
			message: "Only a completed or canceled issue can be archived",
		});
		await update(admin, issue.id, { status: "done" });
		expect(await archive(admin, issue.id, true)).toMatchObject({ type: "ack" });
		const archived = await viewer.op(
			(op) => op.op === "put" && op.entity === "issue" && op.data.archivedAt !== null,
		);
		expect(archived).toMatchObject({ entity: "issue", data: { id: issue.id, status: "done" } });
		// Archived issues stay in the replica, slim, for links, search and progress.
		expect((await snapshotOf(workspace)).issues).toEqual([
			expect.objectContaining({ id: issue.id, archivedAt: expect.any(Number) }),
		]);
		expect(await historyOf(workspace, issue.id)).toContainEqual({
			actorId: owner.id,
			change: { type: "archived", archived: true },
		});

		// Asking again changes nothing.
		const before = (await snapshotOf(workspace)).version;
		await archive(admin, issue.id, true);
		expect((await snapshotOf(workspace)).version).toBe(before);

		await archive(viewer, issue.id, false);
		expect(await issueOf(admin, issue.id)).toMatchObject({ archivedAt: null });
		expect(await historyOf(workspace, issue.id)).toContainEqual({
			actorId: alice.id,
			change: { type: "archived", archived: false },
		});
	});

	it("restores an archived issue that is reopened, and keeps one moved between closed statuses", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const issue = await createIssue(admin, "issue-1");
		await update(admin, issue.id, { status: "done" });
		await archive(admin, issue.id, true);

		await update(member, issue.id, { status: "canceled" });
		expect(await rowOf(admin, issue.id)).toMatchObject({ archivedAt: expect.any(Number) });

		await update(member, issue.id, { status: "in_progress" });
		expect(await issueOf(admin, issue.id)).toMatchObject({
			status: "in_progress",
			archivedAt: null,
		});
		expect((await historyOf(workspace, issue.id)).slice(-2)).toEqual([
			{ actorId: alice.id, change: { type: "status", from: "done", to: "in_progress" } },
			{ actorId: alice.id, change: { type: "archived", archived: false } },
		]);
	});

	it("restores archived issues whose status stops closing them", async () => {
		const { admin } = await withTeam();
		const moved = await createIssue(admin, "issue-1");
		const recategorized = await createIssue(admin, "issue-2");
		await admin.apply({
			name: "status.create",
			args: {
				teamId: TEAM_ID,
				key: "wontfix",
				name: "Won't fix",
				category: "canceled",
				sortOrder: "z0",
			},
		});
		await update(admin, moved.id, { status: "canceled" });
		await update(admin, recategorized.id, { status: "wontfix" });
		await archive(admin, moved.id, true);
		await archive(admin, recategorized.id, true);

		await admin.apply({
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "canceled", moveTo: "backlog" },
		});
		expect(await issueOf(admin, moved.id)).toMatchObject({ status: "backlog", archivedAt: null });

		await admin.apply({
			name: "status.update",
			args: { teamId: TEAM_ID, key: "wontfix", patch: { category: "started" } },
		});
		expect(await issueOf(admin, recategorized.id)).toMatchObject({ archivedAt: null });
	});

	const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };

	/** A closed issue with a description, a label, a comment, history and an agent's proposal. */
	async function withDetails() {
		const { workspace, admin } = await withTeam();
		await workspace.syncMember(triage);
		await admin.apply({
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#e5484d" },
		});
		await admin.apply({
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["title"] } },
		});
		const issue = await createIssue(admin, "issue-1");
		await update(admin, issue.id, { description: "Steps to reproduce", estimate: 3 });
		await admin.apply({ name: "issue.addLabel", args: { id: issue.id, labelId: "label-bug" } });
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-1", issueId: issue.id, body: "Seen on staging" },
		});
		const proposal = await workspace.mutate(triage, "mcp:triage", "m-1", {
			name: "issue.update",
			args: {
				id: issue.id,
				baseVersion: (await issueOf(admin, issue.id)).version,
				patch: { title: "Ship sync faster" },
			},
		});
		expect(proposal).toMatchObject({ ok: true, proposed: [expect.anything()] });
		await update(admin, issue.id, { status: "done" });
		return { workspace, admin, issue };
	}

	/** Alice, connected from the workspace as it is now, so she hears only what comes next. */
	async function liveFrom(workspace: Workspace) {
		const client = await TestClient.connect(workspace, alice);
		await client.hello((await snapshotOf(workspace)).version);
		return client;
	}

	/** The rows a replica ends up with after applying `ops` in order. */
	function replay(ops: readonly Op[]) {
		const rows = new Map<string, unknown>();
		for (const op of ops) {
			if (op.op === "put") rows.set(`${op.entity}:${op.id}`, op.data);
			else rows.delete(`${op.entity}:${op.id}`);
		}
		return rows;
	}

	/** The rows of an issue and of its comments, history and proposals among `rows`. */
	function ofIssue(rows: Map<string, unknown>, issueId: string) {
		return new Map(
			[...rows].filter(([key, row]) => {
				const { id, issueId: of = id } = row as { id: string; issueId?: string };
				const entity = key.split(":")[0] ?? "";
				return of === issueId && ["issue", "comment", "activity", "proposal"].includes(entity);
			}),
		);
	}

	/** Which entities a replica holds of an issue. */
	const heldOf = (rows: Map<string, unknown>, issueId: string) =>
		[...ofIssue(rows, issueId).keys()].map((key) => key.split(":")[0]).sort();

	const slim = (fields: Partial<SyncedIssue> = {}) => ({
		id: "issue-1",
		teamId: TEAM_ID,
		number: 1,
		title: "Ship sync",
		status: "done",
		projectId: null,
		cycleId: null,
		parentId: null,
		estimate: 3,
		archivedAt: expect.any(Number),
		...fields,
	});

	it("keeps an archived issue slim, without its comments, history or proposals", async () => {
		const { workspace, admin, issue } = await withDetails();
		const before = await snapshotOf(workspace);
		const viewer = await liveFrom(workspace);
		expect(before.comments).toHaveLength(1);
		expect(before.proposals).toHaveLength(1);
		const history = before.activities.map((activity) => activity.id);
		expect(history.length).toBeGreaterThan(0);

		expect(await archive(admin, issue.id, true)).toMatchObject({ type: "ack" });
		await viewer.op(
			(op) => op.entity === "issue" && op.op === "put" && op.data.archivedAt !== null,
		);
		const ops = viewer.ops();
		expect(ops.find((op) => op.entity === "issue")).toEqual({
			version: expect.any(Number),
			entity: "issue",
			id: issue.id,
			op: "put",
			data: slim(),
		});
		// What replicas held of it goes, and the history entry that says it was archived never comes.
		expect(ops.filter((op) => op.entity !== "issue")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entity: "comment", id: "comment-1", op: "delete" }),
				expect.objectContaining({ entity: "proposal", id: before.proposals[0]?.id, op: "delete" }),
				...history.map((id) => expect.objectContaining({ entity: "activity", id, op: "delete" })),
			]),
		);
		expect(ops.filter((op) => op.op === "put" && op.entity !== "issue")).toEqual([]);

		const after = await snapshotOf(workspace);
		expect(after.issues).toEqual([slim()]);
		expect(after.comments).toEqual([]);
		expect(after.activities).toEqual([]);
		expect(after.proposals).toEqual([]);
		// The workspace keeps all of it.
		expect(await storedHistory(workspace, issue.id)).toContainEqual(
			expect.objectContaining({ change: { type: "archived", archived: true } }),
		);
		expect(await workspace.comments(issue.id)).toHaveLength(1);
		expect(await workspace.issue(issue.id)).toMatchObject({
			description: "Steps to reproduce",
			labelIds: ["label-bug"],
		});
	});

	it("sends later writes to an archived issue slim, to a client that is live or catching up", async () => {
		const { workspace, admin, issue } = await withDetails();
		await archive(admin, issue.id, true);
		const viewer = await liveFrom(workspace);
		await update(admin, issue.id, { title: "Ship sync again" });
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-2", issueId: issue.id, body: "Still seen" },
		});
		await viewer.op((op) => op.entity === "comment" && op.id === "comment-2");
		expect(viewer.ops()).toEqual([
			expect.objectContaining({
				entity: "issue",
				op: "put",
				data: slim({ title: "Ship sync again" }),
			}),
			...viewer
				.ops()
				.slice(1)
				.map(() => expect.objectContaining({ op: "delete" })),
		]);
		expect(viewer.ops().map((op) => op.entity)).toContain("activity");

		// A client that saw the issue whole catches up to the same slim row and nothing else.
		const late = await TestClient.connect(workspace, alice);
		expect(await late.hello(0)).toMatchObject({ type: "ready" });
		const rows = replay(late.ops());
		expect(heldOf(rows, issue.id)).toEqual(["issue"]);
		expect(rows.get(`issue:${issue.id}`)).toEqual(slim({ title: "Ship sync again" }));
	});

	it("sends an issue back whole when it is restored, with its comments, history and proposals", async () => {
		const { workspace, admin, issue } = await withDetails();
		await archive(admin, issue.id, true);
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-2", issueId: issue.id, body: "Still seen" },
		});
		const viewer = await liveFrom(workspace);
		await archive(viewer, issue.id, false);
		await viewer.op(
			(op) => op.entity === "issue" && op.op === "put" && op.data.archivedAt === null,
		);

		const snapshot = await snapshotOf(workspace);
		expect(snapshot.issues).toEqual([
			expect.objectContaining({
				description: "Steps to reproduce",
				labelIds: ["label-bug"],
				archivedAt: null,
				version: expect.any(Number),
			}),
		]);
		expect(snapshot.comments.map((comment) => comment.id)).toEqual(["comment-1", "comment-2"]);
		expect(snapshot.proposals).toHaveLength(1);
		expect(snapshot.activities.map((activity) => activity.change)).toContainEqual({
			type: "archived",
			archived: false,
		});

		// What a replica holds after the ops is what the snapshot holds, live or catching up.
		const fromSnapshot = new Map<string, unknown>([
			...snapshot.issues.map((row) => [`issue:${row.id}`, row] as const),
			...snapshot.comments.map((row) => [`comment:${row.id}`, row] as const),
			...snapshot.activities.map((row) => [`activity:${row.id}`, row] as const),
			...snapshot.proposals.map((row) => [`proposal:${row.id}`, row] as const),
		]);
		const late = await TestClient.connect(workspace, alice);
		await late.hello(0);
		expect(ofIssue(replay(late.ops()), issue.id)).toEqual(fromSnapshot);
		// The viewer connected while it was archived, so the ops alone bring it all back.
		expect(ofIssue(replay(viewer.ops()), issue.id)).toEqual(fromSnapshot);
	});

	it("leaves an archived issue out of server-side queries that ask so", async () => {
		const { workspace, admin } = await withTeam();
		await createIssue(admin, "issue-1", "Open");
		const done = await createIssue(admin, "issue-2", "Archived");
		await update(admin, done.id, { status: "done" });
		await archive(admin, done.id, true);

		const titles = async (archived?: boolean) =>
			(await workspace.issues({ archived, limit: 10 })).map((issue) => issue.title).sort();
		expect(await titles()).toEqual(["Archived", "Open"]);
		expect(await titles(false)).toEqual(["Open"]);
		expect(await titles(true)).toEqual(["Archived"]);
	});

	it("answers a member an archived issue whole, and writes nothing", async () => {
		const { workspace, admin, issue } = await withDetails();
		await archive(admin, issue.id, true);
		await createIssue(admin, "issue-2", "Still open");
		const viewer = await liveFrom(workspace);
		const before = (await snapshotOf(workspace)).version;

		const details = await workspace.issueDetails(alice, { issueId: issue.id });
		if (!details.ok) throw new Error(details.message);
		expect(details.value.issue).toMatchObject({
			id: issue.id,
			description: "Steps to reproduce",
			labelIds: ["label-bug"],
			archivedAt: expect.any(Number),
			version: expect.any(Number),
		});
		expect(details.value.comments.map((comment) => comment.id)).toEqual(["comment-1"]);
		expect(details.value.activities.map((activity) => activity.change)).toContainEqual({
			type: "archived",
			archived: true,
		});
		expect(details.value.proposals).toMatchObject([
			{ issueId: issue.id, change: { type: "title" } },
		]);
		expect(details.value.pullRequests).toEqual([]);

		// Every archived issue of the workspace, or of a team, whole, for an export.
		const archived = await workspace.archivedIssues(alice, { teamId: null });
		if (!archived.ok || archived.value === "too_large") throw new Error("Not the whole archive");
		expect(archived.value.issues.map((row) => row.id)).toEqual([issue.id]);
		expect(archived.value.issues[0]).toMatchObject({ description: "Steps to reproduce" });
		expect(archived.value.comments.map((comment) => comment.id)).toEqual(["comment-1"]);
		expect(archived.value.activities).toEqual(details.value.activities);
		expect(await workspace.archivedIssues(alice, { teamId: TEAM_ID })).toMatchObject({
			ok: true,
			value: { issues: [{ id: issue.id }] },
		});
		expect(await workspace.archivedIssues(alice, { teamId: "team-other" })).toEqual({
			ok: true,
			value: { issues: [], comments: [], activities: [] },
		});

		// Reading is not writing: no version, and nothing for replicas. The next write's op is the
		// first the viewer hears.
		expect((await snapshotOf(workspace)).version).toBe(before);
		await update(admin, "issue-2", { title: "Still open, renamed" });
		await viewer.op((op) => op.entity === "issue" && op.id === "issue-2");
		expect(viewer.ops()).toEqual([
			expect.objectContaining({ version: before + 1, entity: "issue", id: "issue-2" }),
		]);
	});

	it("pages archived issues by id, each once, for a team or all", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({ name: "team.create", args: { id: "team-ops", key: "OPS", name: "Ops" } });
		// Ids out of their order of creation, two teams, one deleted and one never archived.
		const ids = ["issue-e", "issue-b", "issue-g", "issue-a", "issue-f", "issue-c", "issue-d"];
		for (const [index, id] of ids.entries()) {
			const teamId = index % 2 === 0 ? TEAM_ID : "team-ops";
			await admin.apply({
				name: "issue.create",
				args: { id, teamId, title: id, status: "done", sortOrder: "a0" },
			});
			await admin.apply({
				name: "comment.create",
				args: { id: `comment-${id}`, issueId: id, body: `On ${id}` },
			});
			if (id !== "issue-d") await archive(admin, id, true);
		}
		await admin.apply({ name: "issue.delete", args: { id: "issue-f" } });
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-0", teamId: TEAM_ID, title: "Open", sortOrder: "a0" },
		});

		async function pages(teamId: string | null, limit: number) {
			const read: { ids: string[]; comments: string[]; next: string | null }[] = [];
			let after: string | null = null;
			do {
				const page = await workspace.archivedIssuesPage(owner, { teamId, after, limit });
				if (!page.ok) throw new Error(page.message);
				read.push({
					ids: page.value.issues.map((issue) => issue.id),
					comments: page.value.comments.map((comment) => comment.issueId),
					next: page.value.next,
				});
				after = page.value.next;
			} while (after !== null && read.length < 10);
			return read;
		}

		// By id, two at a time; each page's comments are its issues'.
		const all = await pages(null, 2);
		expect(all.map((page) => page.ids)).toEqual([
			["issue-a", "issue-b"],
			["issue-c", "issue-e"],
			["issue-g"],
		]);
		expect(all.map((page) => page.next)).toEqual(["issue-b", "issue-e", null]);
		for (const page of all) expect(page.comments).toEqual(page.ids);
		// The same pages when asked again, and one page when they fit.
		expect(await pages(null, 2)).toEqual(all);
		expect((await pages(null, 5)).map((page) => page.ids)).toEqual([
			["issue-a", "issue-b", "issue-c", "issue-e", "issue-g"],
		]);
		expect((await pages(null, 200)).map((page) => page.next)).toEqual([null]);

		// One team's, paged the same way.
		expect((await pages(TEAM_ID, 1)).map((page) => page.ids)).toEqual([["issue-e"], ["issue-g"]]);
		expect((await pages("team-ops", 1)).map((page) => page.ids)).toEqual([
			["issue-a"],
			["issue-b"],
			["issue-c"],
		]);

		// An issue restored between pages is on none after; the others are each still on one.
		const first = await workspace.archivedIssuesPage(owner, {
			teamId: null,
			after: null,
			limit: 2,
		});
		if (!first.ok) throw new Error(first.message);
		await archive(admin, "issue-c", false);
		const rest = await workspace.archivedIssuesPage(owner, {
			teamId: null,
			after: first.value.next,
			limit: 200,
		});
		expect(rest).toMatchObject({ ok: true, value: { next: null } });
		if (!rest.ok) throw new Error(rest.message);
		expect([...first.value.issues, ...rest.value.issues].map((issue) => issue.id)).toEqual([
			"issue-a",
			"issue-b",
			"issue-e",
			"issue-g",
		]);

		// A page of more than the most, or a cursor that is not an id, is refused.
		for (const input of [
			{ teamId: null, limit: 201 },
			{ teamId: null, limit: 0 },
			{ teamId: null, after: "" },
			{ teamId: null, after: "x".repeat(65) },
		]) {
			expect(await workspace.archivedIssuesPage(owner, input)).toMatchObject({ reason: "invalid" });
		}
	});

	it("ends a page of archived issues early once it is large", async () => {
		const { workspace, admin } = await withTeam();
		// About 1.5 MB of comments each, so the budget is passed on the third.
		const ids = ["issue-1", "issue-2", "issue-3", "issue-4"];
		for (const id of ids) {
			await admin.apply({
				name: "issue.create",
				args: { id, teamId: TEAM_ID, title: id, status: "done", sortOrder: "a0" },
			});
			for (let n = 0; n < 15; n++) {
				await admin.apply({
					name: "comment.create",
					args: { id: `${id}-comment-${n}`, issueId: id, body: "x".repeat(100_000) },
				});
			}
			await archive(admin, id, true);
		}
		const first = await workspace.archivedIssuesPage(owner, { teamId: null });
		if (!first.ok) throw new Error(first.message);
		expect(first.value.issues.map((issue) => issue.id)).toEqual(["issue-1", "issue-2", "issue-3"]);
		expect(first.value.comments).toHaveLength(45);
		expect(first.value.next).toBe("issue-3");
		const second = await workspace.archivedIssuesPage(owner, { teamId: null, after: "issue-3" });
		expect(second).toMatchObject({ ok: true, value: { issues: [{ id: "issue-4" }], next: null } });
		// Asked without pages, as v0.21.0 asks, it is all of them in one answer, past a page's
		// budget, as long as one answer can hold them.
		const whole = await workspace.archivedIssues(owner, { teamId: null });
		if (!whole.ok || whole.value === "too_large") throw new Error("Not the whole archive");
		expect(whole.value.issues.map((issue) => issue.id)).toEqual(ids);
		expect(whole.value.comments).toHaveLength(60);
	});

	it("refuses the whole archive at once when one answer cannot hold it, never part of it", {
		timeout: 30_000,
	}, async () => {
		const { workspace, admin } = await withTeam();
		// 9 million characters of comments, but 27 MB in UTF-8, over what one answer may hold.
		const ids = ["issue-1", "issue-2", "issue-3", "issue-4", "issue-5", "issue-6"];
		for (const id of ids) {
			await admin.apply({
				name: "issue.create",
				args: { id, teamId: TEAM_ID, title: id, status: "done", sortOrder: "a0" },
			});
			// Through `mutate` inside the object, rather than 27 MB over the socket.
			await runInDurableObject(workspace, (instance) => {
				for (let n = 0; n < 15; n++) {
					const result = instance.mutate(owner, "client-comments", `m-${id}-${n}`, {
						name: "comment.create",
						args: { id: `${id}-comment-${n}`, issueId: id, body: "€".repeat(100_000) },
					});
					if (!result.ok) throw new Error(result.message);
				}
			});
			await archive(admin, id, true);
		}
		expect(await workspace.archivedIssues(owner, { teamId: null })).toEqual({
			ok: true,
			value: "too_large",
		});
		// Pages still bring it all, three issues to a page.
		const first = await workspace.archivedIssuesPage(owner, { teamId: null });
		if (!first.ok) throw new Error(first.message);
		expect(first.value.issues.map((issue) => issue.id)).toEqual(ids.slice(0, 3));
		expect(first.value.comments).toHaveLength(45);
		const second = await workspace.archivedIssuesPage(owner, {
			teamId: null,
			after: first.value.next,
		});
		if (!second.ok) throw new Error(second.message);
		expect(second.value.issues.map((issue) => issue.id)).toEqual(ids.slice(3));
		expect(second.value.comments).toHaveLength(45);
		expect(second.value.next).toBeNull();
		// One team's is measured on its own.
		expect(await workspace.archivedIssues(owner, { teamId: "team-other" })).toEqual({
			ok: true,
			value: { issues: [], comments: [], activities: [] },
		});
	});

	it("answers the whole archive of many small rows, which a character count refused", async () => {
		const { workspace, admin } = await withTeam();
		const ids = ["issue-1", "issue-2", "issue-3"];
		for (const id of ids) {
			await admin.apply({
				name: "issue.create",
				args: { id, teamId: TEAM_ID, title: id, status: "done", sortOrder: "a0" },
			});
			await archive(admin, id, true);
		}
		// Short comments, written straight to storage, since one mutation each would take minutes.
		// The old count allowed 512 characters for each, which put them past its 8M.
		const count = 16_500;
		expect(count * (512 + "Looks good".length)).toBeGreaterThan(8 * 1024 * 1024);
		await runInDurableObject(workspace, (_, state) => {
			drizzle(state.storage, { schema }).run(sql`
				with recursive n(i) as (select 1 union all select i + 1 from n where i < ${count})
				insert into comments (id, issue_id, author_id, body, created_at, updated_at)
				select 'comment-' || i, 'issue-' || (i % 3 + 1), ${owner.id}, 'Looks good', i, i from n`);
		});

		const whole = await workspace.archivedIssues(owner, { teamId: null });
		if (!whole.ok || whole.value === "too_large") throw new Error("Not the whole archive");
		expect(whole.value.issues.map((issue) => issue.id)).toEqual(ids);
		expect(whole.value.comments).toHaveLength(count);
		expect(new Set(whole.value.comments.map((comment) => comment.id)).size).toBe(count);
		expect(whole.value.activities.length).toBeGreaterThan(0);
	});

	it("allows each row of the whole archive what it sends besides its text", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: TEAM_ID,
				title: 'Measure "me" ünd 🧪',
				description: "Line one\nLine two",
				status: "done",
				estimate: 3,
				dueDate: "2026-11-30",
				labelIds: ["label-bug"],
				sortOrder: "a0",
			},
		});
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-1", body: "A comment" },
		});
		await archive(admin, "issue-1", true);

		const whole = await workspace.archivedIssues(owner, { teamId: null });
		if (!whole.ok || whole.value === "too_large") throw new Error("Not the whole archive");
		const [issue] = whole.value.issues;
		const [comment] = whole.value.comments;
		if (!issue || !comment) throw new Error("Not archived");
		expect(whole.value.activities.length).toBeGreaterThan(0);
		expect(overhead(issue, getTableColumns(schema.issues))).toBe(ARCHIVE_ROW_ALLOWANCE.issue);
		expect(overhead(comment, getTableColumns(schema.comments))).toBe(ARCHIVE_ROW_ALLOWANCE.comment);
		for (const activity of whole.value.activities) {
			expect(overhead(activity, getTableColumns(schema.activities))).toBe(
				ARCHIVE_ROW_ALLOWANCE.activity,
			);
		}
	});

	it("counts text with a character past U+00FF at two bytes a character, as RPC sends it", {
		timeout: 30_000,
	}, async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Big", status: "done", sortOrder: "a0" },
		});
		await archive(admin, "issue-1", true);
		// 13 MB in UTF-8, but one emoji in each comment makes structured clone store it all at two
		// bytes a character: 26 MB, over what one answer may hold.
		await runInDurableObject(workspace, (_, state) => {
			drizzle(state.storage, { schema }).run(sql`
				with recursive n(i) as (select 1 union all select i + 1 from n where i < 130)
				insert into comments (id, issue_id, author_id, body, created_at, updated_at)
				select 'comment-' || i, 'issue-1', ${owner.id}, printf('%.*c', 99998, 'x') || '🧪', i, i
				from n`);
		});
		expect(await workspace.archivedIssues(owner, { teamId: null })).toEqual({
			ok: true,
			value: "too_large",
		});
	});

	/** Archives one issue with `count` comments of `body`, written straight to storage. */
	async function archivedWithComments(body: string, count: number) {
		const { workspace, admin } = await withTeam();
		await admin.apply({
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Big", status: "done", sortOrder: "a0" },
		});
		await archive(admin, "issue-1", true);
		const stored = await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`
				with recursive n(i) as (select 1 union all select i + 1 from n where i < ${count})
				insert into comments (id, issue_id, author_id, body, created_at, updated_at)
				select 'comment-' || i, 'issue-1', ${owner.id}, ${body}, i, i from n`);
			return db.get<{ bytes: number }>(
				sql`select length(cast(body as blob)) as bytes from comments limit 1`,
			);
		});
		// Stored whole, NULs and all.
		expect(stored?.bytes).toBe(new TextEncoder().encode(body).length);
		return workspace;
	}

	it("counts wide text after a NUL, which SQLite's length and glob stop at", {
		timeout: 30_000,
	}, async () => {
		// 18 MB in UTF-8, but 36 MB in structured clone, past the RPC limit.
		const workspace = await archivedWithComments(`\0${"x".repeat(99_998)}🧪`, 180);
		expect(await workspace.archivedIssues(owner, { teamId: null })).toEqual({
			ok: true,
			value: "too_large",
		});
	});

	it("counts an emoji at the four bytes structured clone gives it", {
		timeout: 30_000,
	}, async () => {
		// 25 MB in UTF-8, and 25,000 × "ab🧪" is 100,000 UTF-16 units, so 33.4 MB in structured
		// clone, past the RPC limit. Two bytes a code point would count it at 25 MB.
		const workspace = await archivedWithComments("ab🧪".repeat(25_000), 167);
		expect(await workspace.archivedIssues(owner, { teamId: null })).toEqual({
			ok: true,
			value: "too_large",
		});
	});

	it("estimates the whole archive at no less than it comes to, as JSON or structured clone", async () => {
		const { workspace } = await withTeam();
		const texts = [
			"Plain ASCII",
			"Café crème, naïve",
			"ab🧪".repeat(40),
			"\0 hidden wide text: 漢字 🧪",
			"漢字かな交じり文",
			"🧪🧪🧪",
			'Quotes " and \\ and \n escapes',
		];
		await runInDurableObject(workspace, (instance) => {
			for (const [n, text] of texts.entries()) {
				const id = `issue-${n}`;
				const mutations: MutationInput[] = [
					{
						name: "issue.create",
						args: {
							id,
							teamId: TEAM_ID,
							title: text,
							description: text,
							status: "done",
							sortOrder: "a0",
						},
					},
					...texts.map(
						(body, c): MutationInput => ({
							name: "comment.create",
							args: { id: `${id}-comment-${c}`, issueId: id, body },
						}),
					),
					{ name: "issue.archive", args: { id, archived: true } },
				];
				for (const [m, mutation] of mutations.entries()) {
					const result = instance.mutate(owner, "client-estimate", `m-${n}-${m}`, mutation);
					if (!result.ok) throw new Error(result.message);
				}
			}
		});
		const whole = await workspace.archivedIssues(owner, { teamId: null });
		if (!whole.ok || whole.value === "too_large") throw new Error("Not the whole archive");
		expect(whole.value.issues).toHaveLength(texts.length);
		expect(whole.value.comments).toHaveLength(texts.length ** 2);
		const estimate = await runInDurableObject(workspace, (_, state) =>
			archiveSize(drizzle(state.storage, { schema }), null),
		);
		expect(estimate).toBeGreaterThanOrEqual(cloneBytes(whole.value));
		expect(estimate).toBeGreaterThanOrEqual(
			new TextEncoder().encode(JSON.stringify(whole.value)).length,
		);
	});

	it("answers every archived issue at once in v0.21.0's shape when not asked for pages", {
		timeout: 30_000,
	}, async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({ name: "team.create", args: { id: "team-ops", key: "OPS", name: "Ops" } });
		// More than a page holds, in two teams, so a page could not pass for the whole list.
		const count = ARCHIVE_PAGE_SIZE + 5;
		for (let n = 0; n < count; n++) {
			const id = `issue-${String(count - n).padStart(4, "0")}`;
			const teamId = n % 2 === 0 ? TEAM_ID : "team-ops";
			await admin.apply({
				name: "issue.create",
				args: { id, teamId, title: id, status: "done", sortOrder: "a0" },
			});
			await archive(admin, id, true);
		}
		await admin.apply({
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-0001", body: "Last of all" },
		});

		const whole = await workspace.archivedIssues(owner, { teamId: null });
		if (!whole.ok || whole.value === "too_large") throw new Error("Not the whole archive");
		// The keys v0.21.0 reads, and no others: no `next` to suggest there is more.
		expect(Object.keys(whole.value).sort()).toEqual(["activities", "comments", "issues"]);
		expect(whole.value.issues).toHaveLength(count);
		expect(new Set(whole.value.issues.map((issue) => issue.id)).size).toBe(count);
		// By team and number, as v0.21.0's server sent them.
		const order = whole.value.issues.map((issue) => [issue.teamId, issue.number] as const);
		expect(order).toEqual([...order].sort(([a, x], [b, y]) => (a === b ? x - y : a < b ? -1 : 1)));
		expect(whole.value.comments.map((comment) => comment.id)).toEqual(["comment-1"]);
		// Paging, stray fields are ignored, as v0.21.0's schema did with ones it did not know.
		expect(await workspace.archivedIssues(owner, { teamId: TEAM_ID, after: "x" })).toMatchObject({
			ok: true,
			value: { issues: expect.arrayContaining([expect.anything()]) },
		});
		const team = await workspace.archivedIssues(owner, { teamId: "team-ops" });
		if (!team.ok || team.value === "too_large") throw new Error("Not the whole archive");
		expect(team.value.issues).toHaveLength(Math.floor(count / 2));

		// Paged, the same issues, each once, with a cursor.
		const paged: string[] = [];
		let after: string | null = null;
		do {
			const page = await workspace.archivedIssuesPage(owner, { teamId: null, after });
			if (!page.ok) throw new Error(page.message);
			paged.push(...page.value.issues.map((issue) => issue.id));
			after = page.value.next;
		} while (after !== null);
		expect(paged).toHaveLength(count);
		expect(new Set(paged)).toEqual(new Set(whole.value.issues.map((issue) => issue.id)));
	});

	it("refuses whoever is not a member, and ids of issues it does not have", async () => {
		const { workspace, admin, issue } = await withDetails();
		await archive(admin, issue.id, true);
		const forbidden = { ok: false, reason: "forbidden", message: "Not a workspace member" };

		// Bob was never a member here, then is one and is removed: a read lets in neither.
		expect(await workspace.issueDetails(bob, { issueId: issue.id })).toEqual(forbidden);
		expect(await workspace.archivedIssues(bob, { teamId: null })).toEqual(forbidden);
		expect(await workspace.archivedIssuesPage(bob, { teamId: null })).toEqual(forbidden);
		await workspace.syncMember(bob);
		expect(await workspace.issueDetails(bob, { issueId: issue.id })).toMatchObject({ ok: true });
		await workspace.removeMember(bob.id);
		expect(await workspace.issueDetails(bob, { issueId: issue.id })).toEqual(forbidden);
		expect(await workspace.archivedIssues(bob, { teamId: null })).toEqual(forbidden);
		expect(await workspace.archivedIssuesPage(bob, { teamId: null })).toEqual(forbidden);

		// Another workspace's issue is not found here, though its id is real there.
		const other = freshWorkspace();
		const stranger = await TestClient.live(other, owner);
		await stranger.apply({ name: "team.create", args: { id: TEAM_ID, key: "OPS", name: "Ops" } });
		await createIssue(stranger, "issue-elsewhere");
		expect(await other.issueDetails(owner, { issueId: "issue-elsewhere" })).toMatchObject({
			ok: true,
		});
		const notFound = { ok: false, reason: "not_found", message: "Issue not found" };
		expect(await workspace.issueDetails(owner, { issueId: "issue-elsewhere" })).toEqual(notFound);
		expect(await other.issueDetails(owner, { issueId: issue.id })).toEqual(notFound);

		// Nor is a deleted one, and an id that is not one is refused as invalid.
		await createIssue(admin, "issue-2");
		await admin.apply({ name: "issue.delete", args: { id: "issue-2" } });
		expect(await workspace.issueDetails(owner, { issueId: "issue-2" })).toEqual(notFound);
		for (const input of [{ issueId: "" }, { issueId: "x".repeat(65) }, {}, null]) {
			expect(await workspace.issueDetails(owner, input)).toMatchObject({ reason: "invalid" });
		}
		expect(await workspace.archivedIssues(owner, {})).toMatchObject({ reason: "invalid" });
	});
});

describe("intake", () => {
	const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };

	async function fileRequest(client: TestClient, id: string, title = "Export to PDF") {
		await client.apply({
			name: "issue.create",
			args: { id, teamId: TEAM_ID, title, sortOrder: "a0", intake: true },
		});
		return issueOf(client, id);
	}

	async function historyOf(workspace: Workspace, issueId: string) {
		const { activities } = await snapshotOf(workspace);
		return activities
			.filter((activity) => activity.issueId === issueId)
			.map(({ actorId, change }) => ({ actorId, change }));
	}

	it("files a request that everyone sees, and that server-side queries tell apart", async () => {
		const { workspace, admin } = await withTeam();
		const viewer = await TestClient.live(workspace, alice);
		await createIssue(admin, "issue-1", "Planned");
		const request = await fileRequest(viewer, "issue-2", "Requested");
		expect(request).toMatchObject({ intake: true, status: "backlog" });
		expect(await issueOf(admin, "issue-1")).toMatchObject({ intake: false });

		const titles = async (intake?: boolean) =>
			(await workspace.issues({ intake, limit: 10 })).map((issue) => issue.title).sort();
		expect(await titles()).toEqual(["Planned", "Requested"]);
		expect(await titles(true)).toEqual(["Requested"]);
		expect(await titles(false)).toEqual(["Planned"]);
	});

	it("accepts a request into the workflow, in its status or an open one", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const kept = await fileRequest(admin, "issue-1");
		const moved = await fileRequest(admin, "issue-2");

		expect(
			await member.mutate({ name: "issue.accept", args: { id: moved.id, status: "done" } }),
		).toMatchObject({
			type: "reject",
			reason: "invalid",
			message: "Decline a request to close it",
		});
		expect(
			await member.mutate({ name: "issue.accept", args: { id: moved.id, status: "nope" } }),
		).toMatchObject({ type: "reject", reason: "invalid" });

		await member.apply({ name: "issue.accept", args: { id: kept.id } });
		expect(await issueOf(admin, kept.id)).toMatchObject({ intake: false, status: "backlog" });
		await member.apply({ name: "issue.accept", args: { id: moved.id, status: "todo" } });
		expect(await issueOf(admin, moved.id)).toMatchObject({ intake: false, status: "todo" });
		expect(await historyOf(workspace, moved.id)).toEqual([
			{ actorId: alice.id, change: { type: "intake", accepted: true } },
			{ actorId: alice.id, change: { type: "status", from: "backlog", to: "todo" } },
		]);

		// Deciding on what is no longer a request is a conflict, which writes nothing.
		const before = (await snapshotOf(workspace)).version;
		expect(
			await admin.mutate({ name: "issue.accept", args: { id: kept.id, status: "in_progress" } }),
		).toMatchObject({
			type: "reject",
			reason: "conflict",
			message: "Someone already decided on this request",
		});
		expect((await snapshotOf(workspace)).version).toBe(before);
		expect(await admin.mutate({ name: "issue.accept", args: { id: "missing" } })).toMatchObject({
			type: "reject",
			reason: "not_found",
		});
	});

	it("declines a request into the team's first canceled status, with a reply", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		// Alice files it, so she follows it and hears of the reply.
		const request = await fileRequest(member, "issue-1");

		await admin.apply({
			name: "issue.decline",
			args: { id: request.id, reply: { id: "comment-1", body: "Out of scope for now." } },
		});
		expect(await issueOf(member, request.id)).toMatchObject({ intake: false, status: "canceled" });
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.comments).toEqual([
			expect.objectContaining({ id: "comment-1", authorId: owner.id, issueId: request.id }),
		]);
		expect(await historyOf(workspace, request.id)).toEqual([
			{ actorId: owner.id, change: { type: "intake", accepted: false } },
			{ actorId: owner.id, change: { type: "status", from: "backlog", to: "canceled" } },
		]);
		const inbox = (await workspace.snapshot(alice)).inbox;
		expect(inbox.find((item) => item.issueId === request.id)).toMatchObject({ unread: 2 });
	});

	it("refuses to decline where the team has no canceled status", async () => {
		const { admin } = await withTeam();
		const request = await fileRequest(admin, "issue-1");
		await admin.apply({
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "canceled", moveTo: "backlog" },
		});
		expect(
			await admin.mutate({
				name: "issue.decline",
				args: { id: request.id, reply: { id: "comment-1", body: "No" } },
			}),
		).toMatchObject({
			type: "reject",
			reason: "invalid",
			message: "The team has no canceled status to decline into",
		});
	});

	it("lets agents file and work on requests, and turns their decisions into proposals", async () => {
		const { workspace, admin } = await withTeam();
		const agent = await TestClient.live(workspace, triage);
		const request = await fileRequest(agent, "issue-1");
		await agent.apply({
			name: "issue.update",
			args: { id: request.id, baseVersion: request.version, patch: { priority: 2 } },
		});

		// No admin set it to propose anything: deciding on a request is a person's, always.
		await agent.apply({ name: "issue.accept", args: { id: request.id, status: "todo" } });
		const proposals = async () =>
			(await snapshotOf(workspace)).proposals.filter((proposal) => proposal.issueId === request.id);
		expect(await proposals()).toEqual([
			expect.objectContaining({
				agentId: triage.id,
				change: { type: "intake", accepted: true, status: "todo", reply: null },
			}),
		]);
		// Proposing again replaces it, as for any field.
		await agent.apply({
			name: "issue.decline",
			args: { id: request.id, reply: { id: "comment-1", body: "We track this in ENG-9." } },
		});
		expect(await proposals()).toEqual([
			expect.objectContaining({
				change: { type: "intake", accepted: false, status: null, reply: "We track this in ENG-9." },
			}),
		]);
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.comments).toEqual([]);
		expect(await issueOf(admin, request.id)).toMatchObject({ intake: true, priority: 2 });
	});

	it("makes an agent's proposed decline the person's, with the reply it drafted", async () => {
		const { workspace, admin } = await withTeam();
		const agent = await TestClient.live(workspace, triage);
		const request = await fileRequest(admin, "issue-1");
		await agent.apply({
			name: "issue.decline",
			args: { id: request.id, reply: { id: "comment-1", body: "Out of scope." } },
		});
		const [proposal] = (await snapshotOf(workspace)).proposals;
		if (!proposal) throw new Error("No proposal");

		expect(
			await agent.mutate({ name: "proposal.accept", args: { id: proposal.id } }),
		).toMatchObject({ type: "reject", reason: "forbidden" });
		await admin.apply({ name: "proposal.accept", args: { id: proposal.id } });
		expect(await issueOf(admin, request.id)).toMatchObject({ intake: false, status: "canceled" });
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.proposals).toEqual([]);
		expect(snapshot.comments).toEqual([
			expect.objectContaining({ authorId: owner.id, body: "Out of scope.", issueId: request.id }),
		]);
		expect(
			snapshot.activities
				.filter((activity) => activity.issueId === request.id)
				.map(({ actorId, change, proposedBy }) => ({ actorId, change, proposedBy })),
		).toEqual([
			{ actorId: owner.id, change: { type: "intake", accepted: false }, proposedBy: triage.id },
			{
				actorId: owner.id,
				change: { type: "status", from: "backlog", to: "canceled" },
				proposedBy: triage.id,
			},
		]);
	});

	it("settles agents' proposed decisions once a person decides on the request", async () => {
		const { workspace, admin } = await withTeam();
		const agent = await TestClient.live(workspace, triage);
		const request = await fileRequest(admin, "issue-1");
		await agent.apply({ name: "issue.decline", args: { id: request.id } });
		await admin.apply({ name: "issue.accept", args: { id: request.id } });
		expect((await snapshotOf(workspace)).proposals).toEqual([]);
		// Nothing is left to propose on what is no longer a request.
		expect(await agent.mutate({ name: "issue.decline", args: { id: request.id } })).toMatchObject({
			type: "reject",
			reason: "conflict",
		});
	});

	it("files requests through a team's form while an admin has it on", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const formOf = async () =>
			(await snapshotOf(workspace)).teams.find((team) => team.id === TEAM_ID)?.intakeFormKey;
		const turn = (client: TestClient, intakeForm: boolean) =>
			client.mutate({ name: "team.update", args: { id: TEAM_ID, patch: { intakeForm } } });
		const file = (formKey: string, title: string) =>
			workspace.fileRequest({
				via: "form",
				key: formKey,
				title,
				description: "From the site",
				sortOrder: "a5",
			});

		expect(await formOf()).toBeNull();
		expect(await turn(member, true)).toMatchObject({ type: "reject", reason: "forbidden" });
		await turn(admin, true);
		const key = await formOf();
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		if (!key) throw new Error("No form");
		expect(await workspace.intakeForm(key)).toEqual({ teamId: TEAM_ID, teamName: "Engineering" });
		expect(await workspace.intakeForm("0".repeat(32))).toBeNull();

		expect(await file(key, "Export to PDF")).toBe(true);
		const filed = await member.op((op) => op.op === "put" && op.entity === "issue");
		expect(filed).toMatchObject({
			data: {
				title: "Export to PDF",
				description: "From the site",
				intake: true,
				status: "backlog",
				creatorId: "form",
				number: 1,
			},
		});
		expect(await file(key, "  ")).toBe(false);

		// Turned off and on again, the form has a new link, and the old one files nothing.
		await turn(admin, false);
		expect(await file(key, "Late")).toBe(false);
		await turn(admin, true);
		const replaced = await formOf();
		expect(replaced).not.toBe(key);
		expect(await workspace.intakeForm(key)).toBeNull();
		expect((await snapshotOf(workspace)).issues.map((issue) => issue.title)).toEqual([
			"Export to PDF",
		]);
	});

	it("files emailed requests while the team's address is on, each channel by its own key", async () => {
		const { workspace, admin } = await withTeam();
		const team = async () =>
			(await snapshotOf(workspace)).teams.find((each) => each.id === TEAM_ID);
		const turn = (patch: { intakeEmail?: boolean; intakeForm?: boolean }) =>
			admin.apply({ name: "team.update", args: { id: TEAM_ID, patch } });
		const file = (via: "form" | "email", key: string, title: string) =>
			workspace.fileRequest({ via, key, title, description: null, sortOrder: "a5" });

		await turn({ intakeEmail: true, intakeForm: true });
		const { intakeEmailKey: emailKey, intakeFormKey: formKey } = (await team()) ?? {};
		expect(emailKey).toMatch(/^[a-z2-7]{16}$/);
		if (!emailKey || !formKey) throw new Error("No channels");

		expect(await workspace.intakeEmail(emailKey)).toEqual({
			teamId: TEAM_ID,
			teamName: "Engineering",
		});
		expect(await workspace.intakeEmail(formKey)).toBeNull();
		expect(await file("email", emailKey, "Broken export")).toBe(true);
		// A key opens only its own channel.
		expect(await file("form", emailKey, "Wrong way in")).toBe(false);
		expect(await file("email", formKey, "Wrong way in")).toBe(false);
		expect((await snapshotOf(workspace)).issues).toEqual([
			expect.objectContaining({ title: "Broken export", creatorId: "email", intake: true }),
		]);

		await turn({ intakeEmail: false });
		expect((await team())?.intakeEmailKey).toBeNull();
		expect((await team())?.intakeFormKey).toBe(formKey);
		expect(await file("email", emailKey, "Late")).toBe(false);
	});

	it("tells whoever decides second that someone already did, and keeps their reply out", async () => {
		const { workspace, admin } = await withTeam();
		const member = await TestClient.live(workspace, alice);
		const request = await fileRequest(admin, "issue-1");
		await admin.apply({ name: "issue.accept", args: { id: request.id } });
		expect(
			await member.mutate({
				name: "issue.decline",
				args: { id: request.id, reply: { id: "comment-1", body: "Not for now" } },
			}),
		).toMatchObject({ type: "reject", reason: "conflict" });
		const snapshot = await snapshotOf(workspace);
		expect(snapshot.comments).toEqual([]);
		expect(snapshot.issues).toEqual([
			expect.objectContaining({ id: request.id, intake: false, status: "backlog" }),
		]);
	});

	it("makes an earlier offline edit to a request's status conflict once someone decides", async () => {
		const { workspace, admin } = await withTeam();
		const offline = await TestClient.live(workspace, alice);
		const accepted = await fileRequest(admin, "issue-1");
		const declined = await fileRequest(admin, "issue-2");
		await admin.apply({ name: "issue.accept", args: { id: accepted.id, status: "todo" } });
		await admin.apply({ name: "issue.decline", args: { id: declined.id } });

		// Edits made before the decisions, from the versions the person had then.
		for (const request of [accepted, declined]) {
			expect(
				await offline.mutate({
					name: "issue.update",
					args: {
						id: request.id,
						baseVersion: request.version,
						patch: { status: "in_progress" },
					},
				}),
			).toMatchObject({ type: "reject", reason: "conflict" });
		}
		expect(await issueOf(admin, accepted.id)).toMatchObject({ status: "todo" });
		expect(await issueOf(admin, declined.id)).toMatchObject({ status: "canceled" });
	});

	it("never lets a request be closed but by declining it", async () => {
		const { workspace, admin } = await withTeam();
		const agent = await TestClient.live(workspace, triage);
		expect(
			await admin.mutate({
				name: "issue.create",
				args: {
					id: "issue-0",
					teamId: TEAM_ID,
					title: "Done",
					sortOrder: "a0",
					status: "done",
					intake: true,
				},
			}),
		).toMatchObject({
			type: "reject",
			reason: "invalid",
			message: "A request cannot start closed",
		});

		const request = await fileRequest(admin, "issue-1");
		for (const client of [admin, agent]) {
			expect(
				await client.mutate({
					name: "issue.update",
					args: { id: request.id, baseVersion: request.version, patch: { status: "canceled" } },
				}),
			).toMatchObject({
				type: "reject",
				reason: "invalid",
				message: "Accept or decline a request first",
			});
		}
		// Nor through an agent's proposal, which is refused before it is made.
		await admin.apply({
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["status"] } },
		});
		expect(
			await agent.mutate({
				name: "issue.update",
				args: { id: request.id, baseVersion: request.version, patch: { status: "done" } },
			}),
		).toMatchObject({ type: "reject", reason: "invalid" });
		expect((await snapshotOf(workspace)).proposals).toEqual([]);

		// An open status is a change like any other.
		await admin.apply({
			name: "issue.update",
			args: { id: request.id, baseVersion: request.version, patch: { status: "todo" } },
		});
		expect(await issueOf(admin, request.id)).toMatchObject({ intake: true, status: "todo" });
		// An open request cannot be archived either.
		expect(
			await admin.mutate({ name: "issue.archive", args: { id: request.id, archived: true } }),
		).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("declines requests whose status a change to the workflow makes closing", async () => {
		const { workspace, admin } = await withTeam();
		const recategorized = await fileRequest(admin, "issue-1");
		const moved = await fileRequest(admin, "issue-2");
		await admin.apply({
			name: "status.create",
			args: {
				teamId: TEAM_ID,
				key: "triage",
				name: "Triage",
				category: "unstarted",
				sortOrder: "a1",
			},
		});
		for (const [request, status] of [
			[recategorized, "triage"],
			[moved, "todo"],
		] as const) {
			await admin.apply({
				name: "issue.update",
				args: { id: request.id, baseVersion: request.version, patch: { status } },
			});
		}

		await admin.apply({
			name: "status.update",
			args: { teamId: TEAM_ID, key: "triage", patch: { category: "canceled" } },
		});
		expect(await issueOf(admin, recategorized.id)).toMatchObject({
			intake: false,
			status: "triage",
		});
		await admin.apply({
			name: "status.delete",
			args: { teamId: TEAM_ID, key: "todo", moveTo: "done" },
		});
		expect(await issueOf(admin, moved.id)).toMatchObject({ intake: false, status: "done" });

		const { activities } = await snapshotOf(workspace);
		for (const request of [recategorized, moved]) {
			expect(activities.filter((activity) => activity.issueId === request.id).at(-1)).toMatchObject(
				{ actorId: owner.id, change: { type: "intake", accepted: false } },
			);
		}
	});

	it("keeps a request out of the archive until someone decides on it", async () => {
		const { admin } = await withTeam();
		const request = await fileRequest(admin, "issue-1");
		expect(
			await admin.mutate({ name: "issue.archive", args: { id: request.id, archived: true } }),
		).toMatchObject({
			type: "reject",
			reason: "invalid",
			message: "Accept or decline the request before archiving it",
		});
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

describe("views", () => {
	const urgentTodo = { statuses: ["todo" as const], priorities: [1 as const] };

	function createView(client: TestClient, id: string, personal = false, name = "Urgent work") {
		return client.mutate({
			name: "view.create",
			args: { id, name, personal, layout: "board", filters: urgentTodo },
		});
	}

	async function viewsOf(workspace: Workspace) {
		const { views } = await snapshotOf(workspace);
		return views.map(({ id, name, ownerId, creatorId }) => ({ id, name, ownerId, creatorId }));
	}

	it("saves shared and personal views, which reach every member", async () => {
		const workspace = freshWorkspace();
		const author = await TestClient.live(workspace, alice);
		const other = await TestClient.live(workspace, bob);

		expect(await createView(author, "view-shared")).toMatchObject({ type: "ack" });
		expect(await createView(author, "view-mine", true, "  Mine  ")).toMatchObject({ type: "ack" });
		expect(await viewsOf(workspace)).toEqual([
			{ id: "view-shared", name: "Urgent work", ownerId: null, creatorId: alice.id },
			{ id: "view-mine", name: "Mine", ownerId: alice.id, creatorId: alice.id },
		]);
		expect((await snapshotOf(workspace)).views[0]).toMatchObject({
			layout: "board",
			filters: urgentTodo,
		});
		// Personal views are hidden in the app, not secret: every replica holds them.
		const received = await other.op((op) => op.entity === "view" && op.id === "view-mine");
		expect(received).toMatchObject({ op: "put", data: { ownerId: alice.id } });

		expect(await createView(author, "view-shared")).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(
			await author.mutate({
				name: "view.create",
				args: {
					id: "view-bad",
					name: "Bad",
					layout: "board",
					filters: { statuses: ["Not a key"] },
				} as never,
			}),
		).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("keeps a view's display options, and refuses ones it does not know", async () => {
		const workspace = freshWorkspace();
		const author = await TestClient.live(workspace, alice);
		const other = await TestClient.live(workspace, bob);
		const create = (id: string, display: unknown) =>
			author.mutate({
				name: "view.create",
				args: { id, name: id, layout: "list", filters: {}, display } as never,
			});
		const displayOf = async (id: string) =>
			(await snapshotOf(workspace)).views.find((view) => view.id === id)?.display;

		// A view saved without options, and with options that are all the defaults, has none.
		expect(await createView(author, "view-plain")).toMatchObject({ type: "ack" });
		expect(await create("view-default", { groupBy: "status", orderBy: "manual" })).toMatchObject({
			type: "ack",
		});
		expect(await displayOf("view-plain")).toBeNull();
		expect(await displayOf("view-default")).toBeNull();

		// Defaults are dropped and lists put in order, so equal options are stored alike.
		const display = {
			groupBy: "assignee",
			orderBy: "dueDate",
			properties: ["labels", "id"],
			columns: ["status", "title"],
			sort: { column: "dueDate", direction: "desc" },
		};
		expect(await create("view-shown", display)).toMatchObject({ type: "ack" });
		expect(await displayOf("view-shown")).toEqual({
			...display,
			properties: ["id", "labels"],
			columns: ["id", "title", "status"],
		});
		// It reaches other members' replicas with the view.
		const received = await other.op((op) => op.entity === "view" && op.id === "view-shown");
		expect(received).toMatchObject({ op: "put", data: { display: { groupBy: "assignee" } } });

		for (const bad of [
			{ groupBy: "team" },
			{ orderBy: "title" },
			{ properties: ["nope"] },
			{ columns: ["labels", "nope"] },
			{ sort: { column: "labels", direction: "asc" } },
			{ sort: { column: "status", direction: "up" } },
			"status",
		]) {
			expect(await create("view-bad", bad)).toMatchObject({ type: "reject", reason: "invalid" });
		}
		expect(await displayOf("view-bad")).toBeUndefined();

		const update = (patch: unknown) =>
			author.mutate({ name: "view.update", args: { id: "view-shown", patch } as never });
		expect(await update({ display: { groupBy: "project" } })).toMatchObject({ type: "ack" });
		expect(await displayOf("view-shown")).toEqual({ groupBy: "project" });
		// Other fields leave the options as they are; null clears them.
		expect(await update({ name: "Renamed" })).toMatchObject({ type: "ack" });
		expect(await displayOf("view-shown")).toEqual({ groupBy: "project" });
		expect(await update({ display: { groupBy: "bogus" } })).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(await displayOf("view-shown")).toEqual({ groupBy: "project" });
		expect(await update({ display: null })).toMatchObject({ type: "ack" });
		expect(await displayOf("view-shown")).toBeNull();
	});

	it("lets the creator and admins change a shared view, and only the owner a personal one", async () => {
		const workspace = freshWorkspace();
		const admin = await TestClient.live(workspace, owner);
		const author = await TestClient.live(workspace, alice);
		const other = await TestClient.live(workspace, bob);
		await createView(author, "view-shared");
		await createView(author, "view-mine", true);
		const rename = (client: TestClient, id: string, name: string) =>
			client.mutate({ name: "view.update", args: { id, patch: { name } } });

		expect(await rename(other, "view-shared", "Bob's now")).toMatchObject({
			type: "reject",
			reason: "forbidden",
		});
		expect(await rename(admin, "view-mine", "Olivia's now")).toMatchObject({
			type: "reject",
			reason: "forbidden",
		});
		expect(await other.mutate({ name: "view.delete", args: { id: "view-mine" } })).toMatchObject({
			type: "reject",
			reason: "forbidden",
		});
		expect(await rename(other, "view-nope", "Nothing")).toMatchObject({
			type: "reject",
			reason: "not_found",
		});

		expect(await rename(admin, "view-shared", "Triage")).toMatchObject({ type: "ack" });
		expect(
			await author.mutate({
				name: "view.update",
				args: { id: "view-shared", patch: { layout: "table", filters: {} } },
			}),
		).toMatchObject({ type: "ack" });
		expect((await snapshotOf(workspace)).views[0]).toMatchObject({
			name: "Triage",
			layout: "table",
			filters: {},
		});

		// Sharing a personal view hands it to the workspace; making a shared one personal takes it.
		await author.apply({
			name: "view.update",
			args: { id: "view-mine", patch: { personal: false } },
		});
		await admin.apply({
			name: "view.update",
			args: { id: "view-shared", patch: { personal: true } },
		});
		expect(await viewsOf(workspace)).toEqual([
			{ id: "view-shared", name: "Triage", ownerId: owner.id, creatorId: alice.id },
			{ id: "view-mine", name: "Urgent work", ownerId: null, creatorId: alice.id },
		]);
		expect(await rename(author, "view-shared", "Mine again")).toMatchObject({
			type: "reject",
			reason: "forbidden",
		});

		expect(await admin.mutate({ name: "view.delete", args: { id: "view-mine" } })).toMatchObject({
			type: "ack",
		});
		const deleted = await other.op((op) => op.entity === "view" && op.op === "delete");
		expect(deleted).toMatchObject({ id: "view-mine" });
		expect((await viewsOf(workspace)).map(({ id }) => id)).toEqual(["view-shared"]);
		expect(await admin.mutate({ name: "view.delete", args: { id: "view-mine" } })).toMatchObject({
			type: "reject",
			reason: "not_found",
		});
	});

	it("holds at most MAX_VIEWS views", async () => {
		const workspace = freshWorkspace();
		const author = await TestClient.live(workspace, alice);
		await createView(author, "view-0");
		await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			for (let i = 1; i < MAX_VIEWS; i++) {
				db.insert(schema.views)
					.values({
						id: `view-${i}`,
						name: `View ${i}`,
						ownerId: null,
						layout: "list",
						filters: {},
						creatorId: alice.id,
						createdAt: i,
						updatedAt: i,
					})
					.run();
			}
		});
		expect(await createView(author, "view-more")).toMatchObject({
			type: "reject",
			reason: "invalid",
		});
		expect(await author.mutate({ name: "view.delete", args: { id: "view-0" } })).toMatchObject({
			type: "ack",
		});
		expect(await createView(author, "view-more")).toMatchObject({ type: "ack" });
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
		expect(whole(snapshot.issues[0]).labelIds).toEqual(["label-docs"]);
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

describe("project updates", () => {
	const agent: MemberProfile = { ...owner, id: "user-bot", name: "Bot", role: "agent" };
	const AGENT = "mcp:test-agent";

	async function withProject() {
		const { workspace, admin } = await withTeam();
		await admin.apply({ name: "project.create", args: { id: "project-1", name: "Launch" } });
		return { workspace, admin };
	}

	async function post(client: TestClient, id: string, body = "On schedule") {
		return client.apply({
			name: "projectUpdate.create",
			args: { id, projectId: "project-1", health: "on_track", body },
		});
	}

	it("lets any member post, agents included, and only the author edit", async () => {
		const { workspace, admin } = await withProject();
		const member = await TestClient.live(workspace, alice);
		await workspace.syncMember(agent);

		await post(member, "update-1", "  Design is done.  ");
		const byAgent = await workspace.mutate(agent, AGENT, "m-1", {
			name: "projectUpdate.create",
			args: { id: "update-2", projectId: "project-1", health: "at_risk", body: "Two blockers" },
		});
		const byAdmin = await admin.mutate({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: { body: "Rewritten" } },
		});
		const edited = await member.apply({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: { health: "off_track" } },
		});
		const same = await member.apply({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: { health: "off_track", body: "Design is done." } },
		});

		expect(
			await admin.op(
				(op) => op.entity === "projectUpdate" && op.op === "put" && op.id === "update-1",
			),
		).toMatchObject({
			data: {
				projectId: "project-1",
				authorId: alice.id,
				health: "on_track",
				body: "Design is done.",
			},
		});
		expect(byAgent).toMatchObject({ ok: true });
		expect(byAdmin).toMatchObject({ type: "reject", reason: "forbidden" });
		// An edit that changes nothing writes nothing.
		expect(same.version).toBe(edited.version);
		expect((await snapshotOf(workspace)).projectUpdates).toMatchObject([
			{ id: "update-1", health: "off_track", body: "Design is done.", authorId: alice.id },
			{ id: "update-2", health: "at_risk", authorId: agent.id },
		]);
	});

	it("lets the author or an admin delete an update", async () => {
		const { workspace, admin } = await withProject();
		const author = await TestClient.live(workspace, alice);
		const other = await TestClient.live(workspace, bob);
		await post(author, "update-1");
		await post(author, "update-2");

		const byOther = await other.mutate({ name: "projectUpdate.delete", args: { id: "update-1" } });
		await author.apply({ name: "projectUpdate.delete", args: { id: "update-1" } });
		await admin.apply({ name: "projectUpdate.delete", args: { id: "update-2" } });
		const editDeleted = await author.mutate({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: { body: "Back" } },
		});

		expect(byOther).toMatchObject({ type: "reject", reason: "forbidden" });
		expect(
			await other.op(
				(op) => op.entity === "projectUpdate" && op.op === "delete" && op.id === "update-2",
			),
		).toBeTruthy();
		expect(editDeleted).toMatchObject({ type: "reject", reason: "not_found" });
		expect((await snapshotOf(workspace)).projectUpdates).toEqual([]);
	});

	it("rejects empty posts, unknown health, reused ids and missing projects", async () => {
		const { admin } = await withProject();
		await post(admin, "update-1");

		const empty = await admin.mutate({
			name: "projectUpdate.create",
			args: { id: "update-2", projectId: "project-1", health: "on_track", body: "  " },
		});
		const health = await admin.mutate({
			name: "projectUpdate.create",
			// @ts-expect-error: a health the protocol does not know
			args: { id: "update-3", projectId: "project-1", health: "great", body: "Hi" },
		});
		const reused = await admin.mutate({
			name: "projectUpdate.create",
			args: { id: "update-1", projectId: "project-1", health: "on_track", body: "Again" },
		});
		const missing = await admin.mutate({
			name: "projectUpdate.create",
			args: { id: "update-4", projectId: "project-missing", health: "on_track", body: "Hello?" },
		});
		const emptyPatch = await admin.mutate({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: {} },
		});

		expect(empty).toMatchObject({ type: "reject", reason: "invalid" });
		expect(health).toMatchObject({ type: "reject", reason: "invalid" });
		expect(reused).toMatchObject({ type: "reject", reason: "invalid" });
		expect(missing).toMatchObject({ type: "reject", reason: "not_found" });
		expect(emptyPatch).toMatchObject({ type: "reject", reason: "invalid" });
	});

	it("keeps an imported update's original date for an admin only", async () => {
		const { workspace, admin } = await withProject();
		const member = await TestClient.live(workspace, alice);
		const then = Date.UTC(2025, 5, 1);

		await admin.apply({
			name: "projectUpdate.create",
			args: {
				id: "update-1",
				projectId: "project-1",
				health: "on_track",
				body: "Old",
				createdAt: then,
			},
		});
		const byMember = await member.mutate({
			name: "projectUpdate.create",
			args: {
				id: "update-2",
				projectId: "project-1",
				health: "on_track",
				body: "Old",
				createdAt: then,
			},
		});

		expect(byMember).toMatchObject({ type: "reject", reason: "forbidden" });
		expect((await snapshotOf(workspace)).projectUpdates).toMatchObject([
			{ id: "update-1", createdAt: then },
		]);
	});

	it("deletes a project's updates along with the project, before it", async () => {
		const { workspace, admin } = await withProject();
		const viewer = await TestClient.live(workspace, alice);
		await post(admin, "update-1");
		await post(admin, "update-2");

		await admin.apply({ name: "project.delete", args: { id: "project-1" } });
		await viewer.op((op) => op.entity === "project" && op.op === "delete");
		const deletes = viewer
			.ops()
			.filter(
				(op) => op.op === "delete" && (op.entity === "project" || op.entity === "projectUpdate"),
			)
			.map((op) => `${op.entity}:${op.id}`);
		expect(deletes).toEqual([
			"projectUpdate:update-1",
			"projectUpdate:update-2",
			"project:project-1",
		]);
		expect((await snapshotOf(workspace)).projectUpdates).toEqual([]);
		const late = await admin.mutate({
			name: "projectUpdate.update",
			args: { id: "update-1", patch: { body: "Too late" } },
		});
		expect(late).toMatchObject({ type: "reject", reason: "not_found" });
	});
});

describe("insight source", () => {
	it("reads a team's or a project's live issues and only their status changes", async () => {
		const { workspace, admin } = await withTeam();
		await admin.apply({ name: "team.create", args: { id: "team-ops", key: "OPS", name: "Ops" } });
		await admin.apply({ name: "project.create", args: { id: "project-1", name: "Launch" } });
		await createIssue(admin, "issue-1");
		await admin.apply({
			name: "issue.create",
			args: {
				id: "issue-2",
				teamId: "team-ops",
				title: "Ops",
				sortOrder: "a1",
				projectId: "project-1",
			},
		});
		await createIssue(admin, "issue-3");
		await admin.apply({
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { status: "in_progress", priority: 2 } },
		});
		await admin.apply({ name: "issue.delete", args: { id: "issue-3" } });

		const team = await workspace.insightSource({ teamId: TEAM_ID });
		expect(team.issues.map((issue) => issue.id)).toEqual(["issue-1"]);
		expect(team.activities.map((activity) => activity.change)).toEqual([
			{ type: "status", from: "backlog", to: "in_progress" },
		]);
		const project = await workspace.insightSource({ projectId: "project-1" });
		expect(project.issues.map((issue) => issue.id)).toEqual(["issue-2"]);
		expect(project.activities).toEqual([]);
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

	it("closes the sockets of sessions that ended, and only those", async () => {
		const { workspace, admin } = await withTeam();
		const ended = { id: "session-ended", expiresAt: Number.MAX_SAFE_INTEGER };
		const alsoEnded = { id: "session-also-ended", expiresAt: Number.MAX_SAFE_INTEGER };
		const signedOut = await TestClient.connect(workspace, alice, undefined, ended);
		await signedOut.hello();
		const revoked = await TestClient.connect(workspace, alice, undefined, alsoEnded);
		await revoked.hello();
		const stillIn = await TestClient.live(workspace, alice);
		// Another person's socket with the same session id is not theirs to close.
		const other = await TestClient.connect(workspace, bob, undefined, ended);
		await other.hello();

		await workspace.endSessions(alice.id, [ended.id, alsoEnded.id]);

		expect((await signedOut.closed()).code).toBe(CloseCode.SessionEnded);
		expect((await revoked.closed()).code).toBe(CloseCode.SessionEnded);
		await createIssue(admin, "issue-after-sign-out");
		await stillIn.op((op) => op.entity === "issue" && op.id === "issue-after-sign-out");
		await other.op((op) => op.entity === "issue" && op.id === "issue-after-sign-out");
	});

	it("refuses a socket's messages once its session has run out", async () => {
		const { workspace } = await withTeam();
		const session = { id: "session-short", expiresAt: Date.now() + 200 };
		// The owner, who could make the team were the socket still theirs.
		const client = await TestClient.connect(workspace, owner, undefined, session);
		await client.hello();

		await new Promise((resolve) => setTimeout(resolve, 300));
		client.send({
			type: "mutate",
			id: "after-expiry",
			mutation: { name: "team.create", args: { id: "team-late", key: "LATE", name: "Late" } },
		});

		expect((await client.closed()).code).toBe(CloseCode.SessionEnded);
		expect((await snapshotOf(workspace)).teams.map((team) => team.id)).not.toContain("team-late");
	});

	it("sends nothing more to a socket whose session has run out", async () => {
		const { workspace, admin } = await withTeam();
		const session = { id: "session-short", expiresAt: Date.now() + 200 };
		const client = await TestClient.connect(workspace, alice, undefined, session);
		await client.hello();

		await new Promise((resolve) => setTimeout(resolve, 300));
		await createIssue(admin, "issue-after-expiry");

		expect((await client.closed()).code).toBe(CloseCode.SessionEnded);
		expect(client.ops().some((op) => op.id === "issue-after-expiry")).toBe(false);
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
		const setStatus = (status: ActiveIssue["status"]) =>
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
			db.run(sql`drop table project_updates`);
			db.run(sql`drop table statuses`);
			db.run(sql`drop table due_reminders`);
			db.run(sql`drop index issues_due_idx`);
			db.run(sql`drop table notification_settings`);
			db.run(sql`drop table pull_requests`);
			db.run(sql`drop table github_connections`);
			db.run(sql`alter table activities drop column source`);
			db.run(sql`drop table inbox_items`);
			db.run(sql`drop table subscriptions`);
			db.run(sql`alter table oplog drop column audience`);
			db.run(sql`drop index issues_cycle_idx`);
			db.run(sql`alter table issues drop column cycle_id`);
			db.run(sql`alter table teams drop column cycles`);
			db.run(sql`drop table cycles`);
			db.run(sql`drop table views`);
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
			db.run(sql`alter table issues drop column archived_at`);
			db.run(sql`alter table teams drop column archive_after_months`);
			db.run(sql`alter table teams drop column close_after_months`);
			db.run(sql`alter table issues drop column intake`);
			db.run(sql`drop index teams_intake_form_key_unique`);
			db.run(sql`alter table teams drop column intake_form_key`);
			db.run(sql`drop index teams_intake_email_key_unique`);
			db.run(sql`alter table teams drop column intake_email_key`);
			db.run(sql`drop table templates`);
			db.run(sql`drop table requesters`);
			db.run(sql`delete from __drizzle_migrations where created_at >= ${search.when}`);
			await migrate(db, migrations);
		});

		expect(await found(workspace, "kept description before eng-1")).toEqual(["i-1"]);
		expect(await found(workspace, "gone")).toEqual([]);
	});
});
