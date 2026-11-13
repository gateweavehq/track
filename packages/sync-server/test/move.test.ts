import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { MutationInput } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { MEMBER_HEADER, type MemberProfile, moveWorkspace, SESSION_HEADER } from "../src";
import { type MoveManifest, type MoveRows, moveStateAtStart } from "../src/move";
import { freshWorkspace, SESSION, storedHistory, TestClient, type Workspace } from "./client";

// Moving a workspace to another Durable Object (src/move.ts), as the app does to keep it in a
// jurisdiction. Local workerd has no jurisdictions, so these move between two names instead: to
// the move, the other object is just another stub.

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};

const TEAM = "team-eng";

async function must(workspace: Workspace, mutation: MutationInput, id = crypto.randomUUID()) {
	const result = await workspace.mutate(owner, "client-owner", id, mutation);
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
	return result.version;
}

/** Changes an issue as it is now. */
async function update(
	workspace: Workspace,
	id: string,
	patch: { title?: string; status?: "todo" },
) {
	const issue = await workspace.issue(id);
	if (!issue) throw new Error(`No issue ${id}`);
	return must(workspace, { name: "issue.update", args: { id, baseVersion: issue.version, patch } });
}

/** The mutation that renames an issue as it is now, for a client to send. */
async function renaming(workspace: Workspace, id: string, title: string): Promise<MutationInput> {
	const issue = await workspace.issue(id);
	if (!issue) throw new Error(`No issue ${id}`);
	return { name: "issue.update", args: { id, baseVersion: issue.version, patch: { title } } };
}

/** A workspace with a little of everything, and descriptions long enough to need many pages. */
async function filledWorkspace(): Promise<Workspace> {
	const workspace = freshWorkspace();
	await workspace.syncMember(owner);
	await must(workspace, {
		name: "team.create",
		args: { id: TEAM, key: "ENG", name: "Engineering" },
	});
	await must(workspace, {
		name: "label.create",
		args: { id: "label-bug", name: "Bug", color: "#e5484d" },
	});
	for (let n = 1; n <= 12; n++) {
		await must(workspace, {
			name: "issue.create",
			args: {
				id: `i-${n}`,
				teamId: TEAM,
				title: n === 7 ? "Find the needle" : `Issue ${n}`,
				description: `It's ${"long ".repeat(200)}${n}`,
				sortOrder: `a${n}`,
			},
		});
		await must(workspace, {
			name: "comment.create",
			args: { id: `c-${n}`, issueId: `i-${n}`, body: `Comment on ${n}, with 'quotes'` },
		});
	}
	await update(workspace, "i-1", { title: "First" });
	await update(workspace, "i-1", { status: "todo" });
	await must(workspace, { name: "issue.delete", args: { id: "i-12" } });
	return workspace;
}

/** Moves with small pages and quick retries, recording into `recorded`. */
function move(from: Workspace, to: Workspace, recorded: string[] = []) {
	return moveWorkspace(from, to, {
		label: "eu",
		record: async () => {
			recorded.push("eu");
		},
		pageChars: 2000,
		retryMs: 1,
	});
}

/** How a call failed: its error's message, or null if it didn't. */
async function failure(call: Promise<unknown>): Promise<string | null> {
	return call.then(
		() => null,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

function openSocket(workspace: Workspace) {
	return workspace.fetch("https://workspace/socket", {
		headers: {
			Upgrade: "websocket",
			[MEMBER_HEADER]: owner.id,
			[SESSION_HEADER]: JSON.stringify(SESSION),
		},
	});
}

/** A move's target whose pages pass through `write` first, so a test can change them. */
function tampered(to: Workspace, write: (page: MoveRows[]) => MoveRows[]) {
	return {
		// Stubs' methods don't bind.
		moveIn: (token: string, manifest: MoveManifest) => to.moveIn(token, manifest),
		moveCheck: (token: string, manifest: MoveManifest) => to.moveCheck(token, manifest),
		moveDigest: () => to.moveDigest(),
		moveStart: (version: number) => to.moveStart(version),
		moveWrite: async (token: string, page: MoveRows[]) => to.moveWrite(token, write(page)),
	};
}

/** Moves to a tampered target, recording nothing. */
function moveTo(from: Workspace, to: ReturnType<typeof tampered>) {
	return moveWorkspace(from, to, {
		label: "eu",
		record: async () => {},
		pageChars: 2000,
		retryMs: 1,
	});
}

describe("moving a workspace", () => {
	it("copies every row, with its rowid, the versions and the search index", async () => {
		const from = await filledWorkspace();
		const to = freshWorkspace();
		const before = await from.snapshot(owner);
		const history = await storedHistory(from, "i-1");
		const recorded: string[] = [];

		const report = await move(from, to, recorded);

		expect(recorded).toEqual(["eu"]);
		expect(report).toMatchObject({ version: before.version, finished: false });
		expect(report.pages).toBeGreaterThan(3);
		expect(await to.snapshot(owner)).toEqual(before);
		expect(await storedHistory(to, "i-1")).toEqual(history);
		expect(await to.moveDigest()).toEqual(await from.moveDigest());
		const found = await to.issues({ text: "needle", limit: 10 });
		expect(found.map((issue) => issue.id)).toEqual(["i-7"]);
		// And it carries on from there.
		const client = await TestClient.connect(to, owner);
		expect((await client.hello(before.version)).type).toBe("ready");
		await client.apply({
			name: "issue.create",
			args: { id: "i-13", teamId: TEAM, title: "After the move", sortOrder: "b0" },
		});
		const [first] = client.ops();
		expect(first?.version).toBe(before.version + 1);
		expect((await to.issue("i-13"))?.number).toBe(13);
		client.close();
		// Its alarm runs there now.
		expect(await runDurableObjectAlarm(to)).toBe(true);
	});

	it("leaves the old object sealed: no sockets, no writes, no alarm", async () => {
		const from = await filledWorkspace();
		const to = freshWorkspace();
		await move(from, to);

		const socket = await openSocket(from);
		expect(socket.status).toBe(503);
		expect(await failure(from.syncMember({ ...owner, name: "Renamed" }))).toContain(
			"This workspace is moving",
		);
		expect(await runDurableObjectAlarm(from)).toBe(false);
		// A move that comes back to it finds it sealed, and finishes rather than copying again: only
		// into the object that holds its copy.
		expect(await failure(move(from, freshWorkspace()))).toBe(
			"This object doesn't hold the workspace that moved.",
		);
		const recorded: string[] = [];
		expect((await move(from, to, recorded)).finished).toBe(true);
		expect(recorded).toEqual(["eu"]);
	});

	it("closes the sockets, and a client carries on in the new object from its version", async () => {
		const from = await filledWorkspace();
		const to = freshWorkspace();
		const client = await TestClient.live(from, owner, "tab-1");
		const before = await renaming(from, "i-2", "Before");
		await client.apply(before, "m-before");
		const through = (await from.snapshot(owner)).version;

		const moving = move(from, to);
		expect((await client.closed()).code).toBe(1012);
		await moving;

		const again = await TestClient.connect(to, owner, "tab-1");
		expect((await again.hello(through)).type).toBe("ready");
		// A mutation the client sent before, whose ack it never saw, applies once.
		const resent = await again.mutate(before, "m-before");
		expect(resent).toMatchObject({ type: "ack" });
		// One made offline during the move goes through.
		await again.apply(await renaming(to, "i-3", "Offline"), "m-offline");
		expect((await to.issue("i-3"))?.title).toBe("Offline");
		expect((await to.snapshot(owner)).version).toBe(through + 1);
		again.close();
	});

	it("leaves the workspace working where it was when the move gives up", async () => {
		const from = await filledWorkspace();
		const to = freshWorkspace();
		let pages = 0;
		const failing = tampered(to, (page) => {
			pages += 1;
			if (pages === 3) throw new Error("Lost on the way");
			return page;
		});

		expect(await failure(moveTo(from, failing))).toBe("Lost on the way");

		expect((await openSocket(from)).status).toBe(101);
		await update(from, "i-4", { title: "Still here" });
		// The half-filled copy runs nothing.
		expect(await runDurableObjectAlarm(to)).toBe(false);
		// And the move can run again.
		expect((await move(from, to)).finished).toBe(false);
		expect((await to.issue("i-4"))?.title).toBe("Still here");
	});

	it("doesn't seal a copy that differs, even with the same rows", async () => {
		const from = await filledWorkspace();
		const to = freshWorkspace();
		const comment = "Comment on 3, with 'quotes'";
		const changed = tampered(to, (page) =>
			page.map(({ table, rows }) => ({
				table,
				rows:
					table === "comments"
						? rows.map((row) => row.map((value) => (value === comment ? "Changed" : value)))
						: rows,
			})),
		);

		expect(await failure(moveTo(from, changed))).toBe("The copy differs in comments.");
		await update(from, "i-5", { title: "Still here" });
	});

	it("never empties an object that holds a workspace, or the one it moves from", async () => {
		const from = await filledWorkspace();
		const live = await filledWorkspace();

		expect(await failure(move(from, live))).toContain("holds a workspace");
		expect(await failure(move(from, from))).toContain("holds a workspace");
		await update(from, "i-6", { title: "Still here" });
		expect((await live.issue("i-6"))?.title).toBe("Issue 6");
	});

	it("lets one move at a time freeze a workspace", async () => {
		const from = await filledWorkspace();
		const first = await from.moveOut("first", "eu");
		expect(first.frozen).toBe(true);

		expect(await failure(move(from, freshWorkspace()))).toBe(
			"Another move of this workspace is under way.",
		);
		expect(await failure(from.syncMember({ ...owner, name: "Renamed" }))).toContain(
			"This workspace is moving",
		);
		expect(await from.moveThaw("first")).toBe("thawed");
		await from.syncMember({ ...owner, name: "Renamed" });
	});

	it("ends a freeze that lapsed, or that a restart interrupted", async () => {
		const from = await filledWorkspace();
		await from.moveOut("lapsing", "eu");
		await runInDurableObject(from, (_, state) => {
			const freeze = state.storage.kv.get<{ until: number }>("move.freeze");
			state.storage.kv.put("move.freeze", { ...freeze, until: Date.now() - 1 });
		});
		expect(await runDurableObjectAlarm(from)).toBe(true);
		await from.syncMember({ ...owner, name: "After the lapse" });

		await from.moveOut("restarted", "eu");
		await runInDurableObject(from, (_, state) => {
			expect(moveStateAtStart(state.storage)).toBeNull();
		});
		expect(await failure(from.moveRead("restarted", { table: 0, after: null }))).toContain(
			"The move was interrupted",
		);
	});
});
