import type { Issue, Op, Snapshot, Team } from "@gateweave/track-protocol";
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
	labelIds: [],
	sortOrder: "a0",
	version: 2,
	createdAt: 2,
	updatedAt: 2,
};
const snapshot: Snapshot = {
	version: 2,
	teams: [team],
	issues: [issue],
	labels: [],
	comments: [],
	activities: [],
	members: [],
};

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
				labelIds: [],
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

	it("predicts label changes, and replays them safely over the server's result", () => {
		const r = replica();
		r.addPending(
			pending("m1", { name: "label.create", args: { id: "l1", name: "Bug", color: "#e5484d" } }),
			pending("m2", { name: "issue.addLabel", args: { id: "i1", labelId: "l1" } }),
			pending("m3", { name: "issue.addLabel", args: { id: "i1", labelId: "l1" } }),
		);
		expect(r.getState().labels.get("l1")).toMatchObject({ name: "Bug" });
		expect(r.getState().issues.get("i1")?.labelIds).toEqual(["l1"]);

		// The server has applied all three; the acks have not arrived yet.
		const label = { id: "l1", name: "Bug", color: "#e5484d", createdAt: 3, updatedAt: 3 };
		r.applyOps([
			{ version: 3, entity: "label", id: "l1", op: "put", data: label },
			put(4, { ...issue, labelIds: ["l1"], version: 4 }),
		]);
		expect(r.getState().issues.get("i1")?.labelIds).toEqual(["l1"]);

		r.addPending(pending("m4", { name: "issue.removeLabel", args: { id: "i1", labelId: "l1" } }));
		expect(r.getState().issues.get("i1")?.labelIds).toEqual([]);
	});

	it("predicts a label's deletion on every issue that has it", () => {
		const r = replica();
		const label = { id: "l1", name: "Bug", color: "#e5484d", createdAt: 3, updatedAt: 3 };
		r.applyOps([
			{ version: 3, entity: "label", id: "l1", op: "put", data: label },
			put(4, { ...issue, labelIds: ["l1"], version: 4 }),
		]);

		r.addPending(pending("m1", { name: "label.delete", args: { id: "l1" } }));

		expect(r.getState().labels.has("l1")).toBe(false);
		expect(r.getState().issues.get("i1")?.labelIds).toEqual([]);
	});

	it("leaves issues with unknown labels to the server", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "issue.create",
				args: {
					id: "i2",
					teamId: "t1",
					title: "Labeled",
					description: null,
					status: "backlog",
					priority: 0,
					assigneeId: null,
					labelIds: ["unknown"],
					sortOrder: "a1",
				},
			}),
			pending("m2", { name: "issue.addLabel", args: { id: "i1", labelId: "unknown" } }),
		);
		expect(r.getState().issues.has("i2")).toBe(false);
		expect(r.getState().issues.get("i1")?.labelIds).toEqual([]);
	});

	it("predicts comments, and replays them safely over the server's result", () => {
		const r = replica();
		r.addPending(
			pending("m1", { name: "comment.create", args: { id: "c1", issueId: "i1", body: "Hi" } }),
			pending("m2", { name: "comment.create", args: { id: "c2", issueId: "gone", body: "Hm" } }),
		);
		expect(r.getState().comments.get("c1")).toMatchObject({ authorId: "alice", body: "Hi" });
		expect(r.getState().comments.has("c2")).toBe(false);

		const comment = { id: "c1", issueId: "i1", authorId: "alice", body: "Hi", createdAt: 3 };
		r.applyOps([
			{ version: 3, entity: "comment", id: "c1", op: "put", data: { ...comment, updatedAt: 3 } },
		]);
		r.addPending(pending("m3", { name: "comment.update", args: { id: "c1", body: "Hi there" } }));
		expect(r.getState().comments.get("c1")).toMatchObject({ body: "Hi there", createdAt: 3 });

		r.removePending("m1");
		r.removePending("m2");
		r.addPending(pending("m4", { name: "comment.delete", args: { id: "c1" } }));
		expect(r.getState().comments.has("c1")).toBe(false);
	});

	it("leaves other people's comments to the server unless the user is an admin", () => {
		const r = replica();
		const comment = {
			id: "c1",
			issueId: "i1",
			authorId: "bob",
			body: "Mine",
			createdAt: 3,
			updatedAt: 3,
		};
		const alice = {
			id: "alice",
			name: "Alice",
			email: "alice@example.com",
			image: null,
			role: "member" as const,
			removedAt: null,
		};
		r.applyOps([
			{ version: 3, entity: "comment", id: "c1", op: "put", data: comment },
			{ version: 4, entity: "member", id: "alice", op: "put", data: alice },
		]);

		r.addPending(
			pending("m1", { name: "comment.update", args: { id: "c1", body: "Not yours" } }),
			pending("m2", { name: "comment.delete", args: { id: "c1" } }),
		);
		expect(r.getState().comments.get("c1")?.body).toBe("Mine");

		r.applyOps([
			{ version: 5, entity: "member", id: "alice", op: "put", data: { ...alice, role: "admin" } },
		]);
		expect(r.getState().comments.has("c1")).toBe(false);
	});

	it("predicts that an issue's comments and history go with it", () => {
		const r = replica();
		r.applyOps([
			{
				version: 3,
				entity: "comment",
				id: "c1",
				op: "put",
				data: {
					id: "c1",
					issueId: "i1",
					authorId: "alice",
					body: "Hi",
					createdAt: 3,
					updatedAt: 3,
				},
			},
			{
				version: 4,
				entity: "activity",
				id: "a1",
				op: "put",
				data: {
					id: "a1",
					issueId: "i1",
					actorId: "alice",
					change: { type: "status", from: "backlog", to: "todo" },
					createdAt: 4,
					updatedAt: 4,
				},
			},
		]);

		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));

		expect(r.getState().comments.size).toBe(0);
		expect(r.getState().activities.size).toBe(0);
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
