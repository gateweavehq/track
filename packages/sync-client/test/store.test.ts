import type { Issue, Op, Snapshot, Team } from "@tangent/protocol";
import { describe, expect, it } from "vitest";
import { type PendingMutation, Replica } from "../src/store";

const team: Team = { id: "t1", key: "ENG", name: "Engineering", createdAt: 1, updatedAt: 1 };
const issue: Issue = {
	id: "i1",
	teamId: "t1",
	number: 1,
	title: "First",
	description: null,
	status: "backlog",
	priority: 0,
	assigneeId: null,
	creatorId: "alice",
	sortOrder: "a0",
	version: 2,
	createdAt: 2,
	updatedAt: 2,
};
const snapshot: Snapshot = { version: 2, teams: [team], issues: [issue], members: [] };

function replica(): Replica {
	const r = new Replica("alice");
	r.reset(snapshot);
	return r;
}

function pending(id: string, mutation: PendingMutation["mutation"]): PendingMutation {
	return { id, mutation, createdAt: 100 };
}

const put = (version: number, data: Issue): Op => ({
	version,
	entity: "issue",
	id: data.id,
	op: "put",
	data,
});

describe("Replica", () => {
	it("applies ops in order and skips ones it already has", () => {
		const r = replica();
		expect(r.applyOps([put(2, issue), put(3, { ...issue, title: "Renamed", version: 3 })])).toBe(
			true,
		);
		expect(r.version).toBe(3);
		expect(r.getState().issues.get("i1")?.title).toBe("Renamed");
	});

	it("refuses ops that leave a gap, without applying any of them", () => {
		const r = replica();
		const before = r.getState();
		expect(r.applyOps([put(4, { ...issue, title: "Too new" })])).toBe(false);
		expect(r.getState()).toBe(before);
		expect(r.version).toBe(2);
	});

	it("keeps untouched tables and rows identical across changes", () => {
		const r = replica();
		const before = r.getState();
		r.applyOps([{ version: 3, entity: "issue", id: "i1", op: "delete" }]);
		const after = r.getState();
		expect(after.teams).toBe(before.teams);
		expect(after.members).toBe(before.members);
		expect(after.issues).not.toBe(before.issues);
		expect(after.issues.has("i1")).toBe(false);
	});

	it("shows pending mutations on top of the confirmed state", () => {
		const r = replica();
		const teams = r.getState().teams;
		r.addPending(
			pending("m1", {
				name: "issue.update",
				args: { id: "i1", baseVersion: 2, patch: { status: "todo" } },
			}),
		);
		expect(r.getState().issues.get("i1")?.status).toBe("todo");
		expect(r.getState().teams).toBe(teams);
		// Storage only ever sees confirmed state.
		expect(r.snapshot().issues[0]?.status).toBe("backlog");
	});

	it("rebases pending mutations over newer server state", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "issue.update",
				args: { id: "i1", baseVersion: 2, patch: { status: "todo" } },
			}),
		);
		// Someone else renamed the issue meanwhile.
		r.applyOps([put(3, { ...issue, title: "Renamed", version: 3 })]);
		const shown = r.getState().issues.get("i1");
		expect(shown?.title).toBe("Renamed");
		expect(shown?.status).toBe("todo");
	});

	it("drops a mutation's effect when it is removed", () => {
		const r = replica();
		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));
		expect(r.getState().issues.has("i1")).toBe(false);
		r.removePending("m1");
		expect(r.getState().issues.get("i1")).toEqual(issue);
	});

	it("predicts issue numbers and keeps the server's once it arrives", () => {
		const r = replica();
		const create = pending("m1", {
			name: "issue.create",
			args: {
				id: "i2",
				teamId: "t1",
				title: "Second",
				description: null,
				status: "backlog",
				priority: 0,
				assigneeId: null,
				sortOrder: "a1",
			},
		});
		r.addPending(create);
		expect(r.getState().issues.get("i2")).toMatchObject({ number: 2, creatorId: "alice" });

		// The server numbered it 5; until the ack arrives the mutation is still pending, and
		// replaying it must not overwrite the server's row.
		const created: Issue = { ...issue, id: "i2", title: "Second", number: 5, version: 3 };
		r.applyOps([put(3, created)]);
		expect(r.getState().issues.get("i2")).toEqual(created);
		r.removePending("m1");
		expect(r.getState().issues.get("i2")).toEqual(created);
	});

	it("ignores mutations it cannot predict and leaves them to the server", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "issue.update",
				args: { id: "missing", baseVersion: 0, patch: { title: "Nope" } },
			}),
		);
		expect(r.getState().issues.size).toBe(1);
		expect(r.pending).toHaveLength(1);
	});

	it("only replaces state with newer snapshots when asked to", () => {
		const r = replica();
		r.reset({ ...snapshot, version: 1, issues: [] }, { onlyIfNewer: true });
		expect(r.getState().issues.size).toBe(1);
		r.reset({ ...snapshot, version: 1, issues: [] });
		expect(r.getState().issues.size).toBe(0);
		expect(r.version).toBe(1);
	});

	it("notifies subscribers on every change", () => {
		const r = replica();
		let calls = 0;
		const unsubscribe = r.subscribe(() => calls++);
		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));
		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));
		r.removePending("m1");
		unsubscribe();
		r.applyOps([put(3, issue)]);
		expect(calls).toBe(2);
	});
});
