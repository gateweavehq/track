import {
	type Cycle,
	type InboxItem,
	type Issue,
	type Member,
	type Op,
	type Project,
	type Proposal,
	privateId,
	type Snapshot,
	type Team,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { type PendingMutation, Replica } from "../src/store";

const team: Team = {
	id: "t1",
	key: "ENG",
	name: "Engineering",
	cycles: null,
	createdAt: 1,
	updatedAt: 1,
};
const issue: Issue = {
	id: "i1",
	teamId: "t1",
	number: 1,
	title: "First",
	description: null,
	status: "backlog",
	priority: 0,
	assigneeId: null,
	projectId: null,
	cycleId: null,
	parentId: null,
	startDate: null,
	dueDate: null,
	estimate: null,
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
	projects: [],
	cycles: [],
	comments: [],
	activities: [],
	proposals: [],
	relations: [],
	views: [],
	members: [],
	subscriptions: [],
	inbox: [],
	pullRequests: [],
};

function replica(): Replica {
	const r = new Replica("alice");
	r.reset(snapshot);
	return r;
}

function pending(id: string, mutation: PendingMutation["mutation"]): PendingMutation {
	return { id, mutation, createdAt: 100 };
}

/** Applies ops as a delta covering exactly their versions. */
function applyOps(r: Replica, ops: Op[]): boolean {
	const first = ops[0];
	const last = ops.at(-1);
	if (!first || !last) throw new Error("No ops");
	return r.applyDelta({ from: first.version, to: last.version, ops });
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
		expect(applyOps(r, [put(2, issue), put(3, { ...issue, title: "Renamed", version: 3 })])).toBe(
			true,
		);
		expect(r.version).toBe(3);
		expect(r.getState().issues.get("i1")?.title).toBe("Renamed");
	});

	it("refuses ops that leave a gap, without applying any of them", () => {
		const r = replica();
		const before = r.getState();
		expect(applyOps(r, [put(4, { ...issue, title: "Too new" })])).toBe(false);
		expect(r.getState()).toBe(before);
		expect(r.version).toBe(2);
	});

	it("moves to the end of a delta that holds fewer ops than versions", () => {
		const r = replica();
		const renamed = { ...issue, title: "Renamed", version: 4 };
		expect(r.applyDelta({ from: 3, to: 5, ops: [put(4, renamed)] })).toBe(true);
		expect(r.version).toBe(5);
		expect(r.getState().issues.get("i1")?.title).toBe("Renamed");

		// A delta of only other members' ops still moves the version on.
		expect(r.applyDelta({ from: 6, to: 7, ops: [] })).toBe(true);
		expect(r.version).toBe(7);
		// One it already has is skipped; one that starts later leaves a gap.
		expect(r.applyDelta({ from: 3, to: 5, ops: [put(4, issue)] })).toBe(true);
		expect(r.getState().issues.get("i1")?.title).toBe("Renamed");
		expect(r.applyDelta({ from: 9, to: 9, ops: [] })).toBe(false);
		expect(r.version).toBe(7);
	});

	it("keeps untouched tables and rows identical across changes", () => {
		const r = replica();
		const before = r.getState();
		applyOps(r, [{ version: 3, entity: "issue", id: "i1", op: "delete" }]);
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

	it("predicts the original dates of an import, and no later than the mutation", () => {
		const r = replica();
		const now = Date.UTC(2026, 9, 30);
		const opened = Date.UTC(2024, 2, 1);
		r.addPending({
			id: "m1",
			createdAt: now,
			mutation: {
				name: "issue.create",
				args: { ...issue, id: "i2", labelIds: [], createdAt: opened },
			},
		});
		r.addPending({
			id: "m2",
			createdAt: now,
			mutation: {
				name: "comment.create",
				args: { id: "c1", issueId: "i2", body: "Old", createdAt: opened },
			},
		});
		r.addPending({
			id: "m3",
			createdAt: now,
			mutation: { name: "issue.create", args: { ...issue, id: "i3", createdAt: now + 1000 } },
		});
		expect(r.getState().issues.get("i2")).toMatchObject({ createdAt: opened, updatedAt: now });
		expect(r.getState().comments.get("c1")).toMatchObject({ createdAt: opened });
		expect(r.getState().issues.get("i3")?.createdAt).toBe(now);
	});

	it("predicts dates and estimates, and clearing them", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "issue.update",
				args: { id: "i1", baseVersion: 2, patch: { dueDate: "2026-11-20", estimate: 3 } },
			}),
		);
		expect(r.getState().issues.get("i1")).toMatchObject({ dueDate: "2026-11-20", estimate: 3 });
		r.addPending(
			pending("m2", {
				name: "issue.update",
				args: { id: "i1", baseVersion: 2, patch: { dueDate: null } },
			}),
		);
		expect(r.getState().issues.get("i1")).toMatchObject({ dueDate: null, estimate: 3 });
	});

	it("predicts a new parent, and taking it away", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "issue.update",
				args: { id: "i1", baseVersion: 2, patch: { parentId: "i0" } },
			}),
		);
		expect(r.getState().issues.get("i1")?.parentId).toBe("i0");
		r.removePending("m1");
		expect(r.getState().issues.get("i1")?.parentId).toBeNull();
	});

	it("predicts relations, one per pair, and replacing the pair's", () => {
		const r = new Replica("alice");
		const other: Issue = { ...issue, id: "i2", number: 2 };
		r.reset({ ...snapshot, issues: [issue, other] });
		const relate = (id: string, type: "blocks" | "related", from: string, to: string) =>
			pending(id, {
				name: "relation.create",
				args: { id, type, issueId: from, relatedIssueId: to },
			});

		r.addPending(relate("m1", "blocks", "i1", "i2"));
		expect([...r.getState().relations.values()]).toEqual([
			{
				id: "m1",
				type: "blocks",
				issueId: "i1",
				relatedIssueId: "i2",
				creatorId: "alice",
				createdAt: 100,
			},
		]);
		r.addPending(relate("m2", "blocks", "i1", "i2"));
		r.addPending(relate("m3", "related", "i2", "i1"));
		expect([...r.getState().relations.keys()]).toEqual(["m3"]);
		r.addPending(relate("m4", "related", "i1", "i1"));
		r.addPending(relate("m5", "related", "i1", "i9"));
		expect([...r.getState().relations.keys()]).toEqual(["m3"]);

		r.addPending(pending("m6", { name: "relation.delete", args: { id: "m3" } }));
		expect(r.getState().relations.size).toBe(0);
	});

	it("predicts saved views, and replays them over the server's result", () => {
		const r = replica();
		const filters = { statuses: ["todo" as const] };
		r.addPending(
			pending("m1", {
				name: "view.create",
				args: { id: "v1", name: "Todo", personal: false, layout: "list", filters },
			}),
			pending("m2", {
				name: "view.create",
				args: { id: "v2", name: "Mine", personal: true, layout: "board", filters: {} },
			}),
		);
		expect(r.getState().views.get("v1")).toEqual({
			id: "v1",
			name: "Todo",
			ownerId: null,
			layout: "list",
			filters,
			display: null,
			creatorId: "alice",
			createdAt: 100,
			updatedAt: 100,
		});
		expect(r.getState().views.get("v2")?.ownerId).toBe("alice");

		// The server has applied the first; replaying it keeps the server's row.
		const saved = {
			id: "v1",
			name: "Todo",
			ownerId: null,
			layout: "list" as const,
			filters,
			display: null,
			creatorId: "alice",
			createdAt: 3,
			updatedAt: 3,
		};
		applyOps(r, [{ version: 3, entity: "view", id: "v1", op: "put", data: saved }]);
		expect(r.getState().views.get("v1")?.createdAt).toBe(3);

		r.addPending(
			pending("m3", {
				name: "view.update",
				args: { id: "v1", patch: { name: "Open", personal: true, layout: "table" } },
			}),
		);
		expect(r.getState().views.get("v1")).toMatchObject({
			name: "Open",
			ownerId: "alice",
			layout: "table",
			filters,
		});
		r.addPending(pending("m4", { name: "view.delete", args: { id: "v2" } }));
		expect(r.getState().views.has("v2")).toBe(false);
	});

	it("predicts a view's display options, kept in their stored form", () => {
		const r = replica();
		r.addPending(
			pending("m1", {
				name: "view.create",
				args: {
					id: "v1",
					name: "By priority",
					personal: false,
					layout: "board",
					filters: {},
					display: { groupBy: "priority", orderBy: "manual", columns: ["title", "id", "status"] },
				},
			}),
			pending("m2", {
				name: "view.create",
				args: {
					id: "v2",
					name: "Plain",
					personal: false,
					layout: "list",
					filters: {},
					display: { groupBy: "status" },
				},
			}),
		);
		// Defaults are dropped and lists put in order, as the server stores them.
		expect(r.getState().views.get("v1")?.display).toEqual({
			groupBy: "priority",
			columns: ["id", "title", "status"],
		});
		expect(r.getState().views.get("v2")?.display).toBeNull();

		r.addPending(
			pending("m3", {
				name: "view.update",
				args: { id: "v1", patch: { display: { orderBy: "dueDate" } } },
			}),
			pending("m4", { name: "view.update", args: { id: "v2", patch: { name: "Still plain" } } }),
		);
		expect(r.getState().views.get("v1")?.display).toEqual({ orderBy: "dueDate" });
		expect(r.getState().views.get("v2")?.display).toBeNull();

		r.addPending(
			pending("m5", { name: "view.update", args: { id: "v1", patch: { display: null } } }),
		);
		expect(r.getState().views.get("v1")?.display).toBeNull();
	});

	it("leaves views the user may not change to the server", () => {
		const r = replica();
		const view = (id: string, ownerId: string | null) => ({
			id,
			name: id,
			ownerId,
			layout: "list" as const,
			filters: {},
			display: null,
			creatorId: "bob",
			createdAt: 3,
			updatedAt: 3,
		});
		const alice = {
			id: "alice",
			name: "Alice",
			email: "alice@example.com",
			image: null,
			role: "member" as const,
			proposes: [],
			removedAt: null,
		};
		applyOps(r, [
			{ version: 3, entity: "view", id: "shared", op: "put", data: view("shared", null) },
			{ version: 4, entity: "view", id: "bobs", op: "put", data: view("bobs", "bob") },
			{ version: 5, entity: "member", id: "alice", op: "put", data: alice },
		]);

		r.addPending(
			pending("m1", { name: "view.update", args: { id: "shared", patch: { name: "Mine" } } }),
			pending("m2", { name: "view.delete", args: { id: "bobs" } }),
		);
		expect(r.getState().views.get("shared")?.name).toBe("shared");
		expect(r.getState().views.has("bobs")).toBe(true);

		// An admin changes shared views, but still not someone's personal one.
		applyOps(r, [
			{ version: 6, entity: "member", id: "alice", op: "put", data: { ...alice, role: "admin" } },
		]);
		expect(r.getState().views.get("shared")?.name).toBe("Mine");
		expect(r.getState().views.has("bobs")).toBe(true);
	});

	it("predicts deleting an issue takes its relations and frees its sub-issues", () => {
		const r = new Replica("alice");
		const child: Issue = { ...issue, id: "i2", number: 2, parentId: "i1" };
		const other: Issue = { ...issue, id: "i3", number: 3 };
		r.reset({
			...snapshot,
			issues: [issue, child, other],
			relations: [
				{
					id: "r1",
					type: "blocks",
					issueId: "i3",
					relatedIssueId: "i1",
					creatorId: "alice",
					createdAt: 1,
				},
				{
					id: "r2",
					type: "related",
					issueId: "i2",
					relatedIssueId: "i3",
					creatorId: "alice",
					createdAt: 1,
				},
			],
		});

		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));

		expect([...r.getState().relations.keys()]).toEqual(["r2"]);
		expect(r.getState().issues.get("i2")?.parentId).toBeNull();
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
		applyOps(r, [put(3, { ...issue, title: "Renamed", version: 3 })]);
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
				projectId: null,
				cycleId: null,
				parentId: null,
				startDate: null,
				dueDate: null,
				estimate: null,
				labelIds: [],
				sortOrder: "a1",
			},
		});
		r.addPending(create);
		expect(r.getState().issues.get("i2")).toMatchObject({ number: 2, creatorId: "alice" });

		// The server numbered it 5; until the ack arrives the mutation is still pending, and
		// replaying it must not overwrite the server's row.
		const created: Issue = { ...issue, id: "i2", title: "Second", number: 5, version: 3 };
		applyOps(r, [put(3, created)]);
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
		applyOps(r, [
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
		applyOps(r, [
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
					projectId: null,
					cycleId: null,
					parentId: null,
					startDate: null,
					dueDate: null,
					estimate: null,
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
		applyOps(r, [
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
			proposes: [],
			removedAt: null,
		};
		applyOps(r, [
			{ version: 3, entity: "comment", id: "c1", op: "put", data: comment },
			{ version: 4, entity: "member", id: "alice", op: "put", data: alice },
		]);

		r.addPending(
			pending("m1", { name: "comment.update", args: { id: "c1", body: "Not yours" } }),
			pending("m2", { name: "comment.delete", args: { id: "c1" } }),
		);
		expect(r.getState().comments.get("c1")?.body).toBe("Mine");

		applyOps(r, [
			{ version: 5, entity: "member", id: "alice", op: "put", data: { ...alice, role: "admin" } },
		]);
		expect(r.getState().comments.has("c1")).toBe(false);
	});

	it("predicts that an issue's comments and history go with it", () => {
		const r = replica();
		applyOps(r, [
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
					proposedBy: null,
					source: null,
					createdAt: 4,
					updatedAt: 4,
				},
			},
			{
				version: 5,
				entity: "proposal",
				id: "p1",
				op: "put",
				data: {
					id: "p1",
					issueId: "i1",
					agentId: "bot",
					change: { type: "status", to: "done" },
					createdAt: 5,
					updatedAt: 5,
				},
			},
		]);

		r.addPending(pending("m1", { name: "issue.delete", args: { id: "i1" } }));

		expect(r.getState().comments.size).toBe(0);
		expect(r.getState().activities.size).toBe(0);
		expect(r.getState().proposals.size).toBe(0);
	});

	it("predicts what an admin sets an agent to propose", () => {
		const r = replica();
		const member = (id: string, role: Member["role"]): Member => ({
			id,
			name: id,
			email: `${id}@example.com`,
			image: null,
			role,
			proposes: [],
			removedAt: null,
		});
		applyOps(r, [
			{ version: 3, entity: "member", id: "alice", op: "put", data: member("alice", "member") },
			{ version: 4, entity: "member", id: "bot", op: "put", data: member("bot", "agent") },
		]);
		const setting = pending("m1", {
			name: "agent.update",
			args: { id: "bot", patch: { proposes: ["labels", "status", "labels"] } },
		});

		// Only admins set it, so a member's attempt is left to the server to refuse.
		r.addPending(setting);
		expect(r.getState().members.get("bot")?.proposes).toEqual([]);

		applyOps(r, [
			{ version: 5, entity: "member", id: "alice", op: "put", data: member("alice", "admin") },
		]);
		expect(r.getState().members.get("bot")?.proposes).toEqual(["status", "labels"]);
	});

	describe("inbox", () => {
		const item: InboxItem = {
			id: privateId("i1", "alice"),
			issueId: "i1",
			memberId: "alice",
			event: { type: "assigned" },
			actorId: "bob",
			unread: 2,
			updatedAt: 50,
			snoozedUntil: null,
			archivedAt: null,
		};
		const alice = (role: Member["role"]): Member => ({
			id: "alice",
			name: "Alice",
			email: "alice@example.com",
			image: null,
			role,
			proposes: [],
			removedAt: null,
		});
		const withItem = (role: Member["role"] = "member") => {
			const r = new Replica("alice");
			r.reset({ ...snapshot, members: [alice(role)], inbox: [item] });
			return r;
		};
		const update = (
			seen: number,
			patch: { read?: boolean; archived?: boolean; snoozedUntil?: number | null },
		) =>
			pending("m1", {
				name: "inbox.update",
				args: { items: [{ issueId: "i1", seen }], patch },
			});

		it("predicts reading, archiving and snoozing, and replays over the server's result", () => {
			const r = withItem();
			r.addPending(update(50, { archived: true, snoozedUntil: 500 }));
			const predicted = r.getState().inbox.get(item.id);
			expect(predicted).toMatchObject({ unread: 0, archivedAt: 100, snoozedUntil: 500 });

			applyOps(r, [
				{
					version: 3,
					entity: "inbox",
					id: item.id,
					op: "put",
					data: { ...item, unread: 0, archivedAt: 90, snoozedUntil: 500 },
				},
			]);
			expect(r.getState().inbox.get(item.id)).toMatchObject({ archivedAt: 90, snoozedUntil: 500 });
		});

		it("leaves news the person has not seen unread, and unreads on request", () => {
			const r = withItem();
			r.addPending(update(49, { read: true, archived: true }));
			expect(r.getState().inbox.get(item.id)).toEqual(item);
			r.removePending("m1");

			r.reset({ ...snapshot, members: [alice("member")], inbox: [{ ...item, unread: 0 }] });
			r.addPending(update(0, { read: false }));
			expect(r.getState().inbox.get(item.id)?.unread).toBe(1);
		});

		it("predicts subscribing, but nothing for agents", () => {
			const r = withItem();
			r.addPending(
				pending("m1", { name: "issue.subscribe", args: { issueId: "i1", subscribed: false } }),
			);
			expect(r.getState().subscriptions.get(privateId("i1", "alice"))).toMatchObject({
				subscribed: false,
				memberId: "alice",
			});

			const agent = withItem("agent");
			agent.addPending(
				pending("m1", { name: "issue.subscribe", args: { issueId: "i1", subscribed: true } }),
			);
			expect(agent.getState().subscriptions.size).toBe(0);
		});
	});

	describe("cycles", () => {
		const cycle = (id: string, fields: Partial<Cycle> = {}): Cycle => ({
			id,
			teamId: "t1",
			number: 1,
			name: null,
			startsOn: "2026-11-02",
			endsOn: "2026-11-15",
			completedAt: null,
			createdAt: 3,
			updatedAt: 3,
			...fields,
		});
		const putCycle = (version: number, data: Cycle): Op => ({
			version,
			entity: "cycle",
			id: data.id,
			op: "put",
			data,
		});
		const move = (id: string, cycleId: string | null) =>
			pending(id, { name: "issue.update", args: { id: "i1", baseVersion: 2, patch: { cycleId } } });

		it("keeps a team's cycle settings without the start day, which only the server uses", () => {
			const r = replica();
			r.addPending(
				pending("m1", {
					name: "team.update",
					args: {
						id: "t1",
						patch: { cycles: { weeks: 2, timeZone: "Europe/Istanbul", startsOn: "2026-11-02" } },
					},
				}),
			);
			expect(r.getState().teams.get("t1")?.cycles).toEqual({
				weeks: 2,
				timeZone: "Europe/Istanbul",
			});
			r.addPending(
				pending("m2", { name: "team.update", args: { id: "t1", patch: { cycles: null } } }),
			);
			expect(r.getState().teams.get("t1")?.cycles).toBeNull();
		});

		it("predicts an issue joining a cycle of its team that has not completed, and no other", () => {
			const r = replica();
			applyOps(r, [
				putCycle(3, cycle("c1")),
				putCycle(4, cycle("c0", { number: 0, completedAt: 3 })),
				putCycle(5, cycle("ops-1", { teamId: "t2" })),
			]);
			r.addPending(move("m1", "c0"), move("m2", "ops-1"), move("m3", "missing"));
			expect(r.getState().issues.get("i1")?.cycleId).toBeNull();

			r.addPending(move("m4", "c1"));
			expect(r.getState().issues.get("i1")?.cycleId).toBe("c1");
			r.addPending(move("m5", null));
			expect(r.getState().issues.get("i1")?.cycleId).toBeNull();
		});

		it("predicts naming a cycle", () => {
			const r = replica();
			applyOps(r, [putCycle(3, cycle("c1"))]);
			r.addPending(
				pending("m1", { name: "cycle.update", args: { id: "c1", patch: { name: "Launch" } } }),
			);
			expect(r.getState().cycles.get("c1")?.name).toBe("Launch");
			expect(r.snapshot().cycles[0]?.name).toBeNull();
		});
	});

	describe("projects", () => {
		const person = (id: string, role: Member["role"]): Member => ({
			id,
			name: id,
			email: `${id}@example.com`,
			image: null,
			role,
			proposes: [],
			removedAt: null,
		});
		const project: Project = {
			id: "p1",
			name: "Launch",
			description: null,
			status: "planned",
			leadId: null,
			targetDate: null,
			createdAt: 3,
			updatedAt: 3,
		};
		const putMember = (version: number, member: Member): Op => ({
			version,
			entity: "member",
			id: member.id,
			op: "put",
			data: member,
		});
		const putProject = (version: number, data: Project): Op => ({
			version,
			entity: "project",
			id: data.id,
			op: "put",
			data,
		});
		const create = pending("m1", {
			name: "project.create",
			args: {
				id: "p1",
				name: "Launch",
				description: null,
				status: "planned",
				leadId: null,
				targetDate: null,
			},
		});

		it("predicts creating and updating a project, and replays them over the server's result", () => {
			const r = replica();
			r.addPending(
				create,
				pending("m2", {
					name: "project.update",
					args: { id: "p1", patch: { status: "started", targetDate: "2026-12-31" } },
				}),
			);
			expect(r.getState().projects.get("p1")).toMatchObject({
				name: "Launch",
				status: "started",
				targetDate: "2026-12-31",
			});

			// The server has applied both; the acks have not arrived yet.
			const confirmed = { ...project, status: "started" as const, targetDate: "2026-12-31" };
			applyOps(r, [putProject(3, project), putProject(4, confirmed)]);
			expect(r.getState().projects.get("p1")).toMatchObject({ ...confirmed, updatedAt: 100 });
			r.removePending("m1");
			r.removePending("m2");
			expect(r.getState().projects.get("p1")).toEqual(confirmed);
			expect(r.snapshot().projects).toEqual([confirmed]);
		});

		it("rolls a project back when its mutation is removed", () => {
			const r = replica();
			r.addPending(create);
			expect(r.getState().projects.has("p1")).toBe(true);
			r.removePending("m1");
			expect(r.getState().projects.has("p1")).toBe(false);
		});

		it("leaves what the server would refuse to the server", () => {
			const r = replica();
			applyOps(r, [
				putMember(3, person("alice", "member")),
				putMember(4, person("bot", "agent")),
				putProject(5, project),
			]);
			r.addPending(
				pending("m1", {
					name: "project.create",
					args: {
						id: "p2",
						name: "Led by an agent",
						description: null,
						status: "planned",
						leadId: "bot",
						targetDate: null,
					},
				}),
				pending("m2", { name: "project.update", args: { id: "p1", patch: { leadId: "ghost" } } }),
				pending("m3", { name: "project.delete", args: { id: "p1" } }),
				pending("m4", {
					name: "issue.update",
					args: { id: "i1", baseVersion: 2, patch: { projectId: "missing" } },
				}),
			);
			expect(r.getState().projects.has("p2")).toBe(false);
			expect(r.getState().projects.get("p1")?.leadId).toBeNull();
			// Only admins delete projects.
			expect(r.getState().projects.has("p1")).toBe(true);
			expect(r.getState().issues.get("i1")?.projectId).toBeNull();
		});

		it("predicts an issue's project, and that deleting the project clears it", () => {
			const r = replica();
			applyOps(r, [putMember(3, person("alice", "admin")), putProject(4, project)]);
			r.addPending(
				pending("m1", {
					name: "issue.update",
					args: { id: "i1", baseVersion: 2, patch: { projectId: "p1" } },
				}),
				pending("m2", {
					name: "issue.create",
					args: {
						id: "i2",
						teamId: "t1",
						title: "In the project",
						description: null,
						status: "backlog",
						priority: 0,
						assigneeId: null,
						projectId: "p1",
						cycleId: null,
						parentId: null,
						startDate: null,
						dueDate: null,
						estimate: null,
						labelIds: [],
						sortOrder: "a1",
					},
				}),
			);
			expect(r.getState().issues.get("i1")?.projectId).toBe("p1");
			expect(r.getState().issues.get("i2")?.projectId).toBe("p1");

			r.addPending(pending("m3", { name: "project.delete", args: { id: "p1" } }));
			expect(r.getState().projects.has("p1")).toBe(false);
			expect(r.getState().issues.get("i1")?.projectId).toBeNull();
			expect(r.getState().issues.get("i2")?.projectId).toBeNull();
		});

		it("leaves a new issue in an unknown project to the server", () => {
			const r = replica();
			r.addPending(
				pending("m1", {
					name: "issue.create",
					args: {
						id: "i2",
						teamId: "t1",
						title: "Nowhere",
						description: null,
						status: "backlog",
						priority: 0,
						assigneeId: null,
						projectId: "unknown",
						cycleId: null,
						parentId: null,
						startDate: null,
						dueDate: null,
						estimate: null,
						labelIds: [],
						sortOrder: "a1",
					},
				}),
			);
			expect(r.getState().issues.has("i2")).toBe(false);
		});

		it("predicts accepting a proposed project", () => {
			const r = replica();
			applyOps(r, [
				putProject(3, project),
				{
					version: 4,
					entity: "proposal",
					id: "pr1",
					op: "put",
					data: {
						id: "pr1",
						issueId: "i1",
						agentId: "bot",
						change: { type: "project", to: "p1" },
						createdAt: 4,
						updatedAt: 4,
					},
				},
			]);
			r.addPending(pending("m1", { name: "proposal.accept", args: { id: "pr1" } }));
			expect(r.getState().issues.get("i1")?.projectId).toBe("p1");
			expect(r.getState().proposals.size).toBe(0);
		});
	});

	it("predicts accepting and dismissing proposals, and replays them over the server's result", () => {
		const r = replica();
		const label = { id: "l1", name: "Bug", color: "#e5484d", createdAt: 3, updatedAt: 3 };
		const proposal = (id: string, change: Proposal["change"]): Op => ({
			version: 0,
			entity: "proposal",
			id,
			op: "put",
			data: { id, issueId: "i1", agentId: "bot", change, createdAt: 4, updatedAt: 4 },
		});
		applyOps(r, [
			{ version: 3, entity: "label", id: "l1", op: "put", data: label },
			{ ...proposal("p1", { type: "status", to: "done" }), version: 4 },
			{ ...proposal("p2", { type: "label", labelId: "l1", added: true }), version: 5 },
			{ ...proposal("p3", { type: "priority", to: 1 }), version: 6 },
		]);

		r.addPending(
			pending("m1", { name: "proposal.accept", args: { id: "p1" } }),
			pending("m2", { name: "proposal.accept", args: { id: "p2" } }),
			pending("m3", { name: "proposal.dismiss", args: { id: "p3" } }),
		);
		expect(r.getState().issues.get("i1")).toMatchObject({
			status: "done",
			labelIds: ["l1"],
			priority: 0,
		});
		expect(r.getState().proposals.size).toBe(0);

		// The server has decided all three; the acks have not arrived yet.
		applyOps(r, [
			put(7, { ...issue, status: "done", version: 7 }),
			{ version: 8, entity: "proposal", id: "p1", op: "delete" },
			put(9, { ...issue, status: "done", labelIds: ["l1"], version: 9 }),
			{ version: 10, entity: "proposal", id: "p2", op: "delete" },
			{ version: 11, entity: "proposal", id: "p3", op: "delete" },
		]);
		expect(r.getState().issues.get("i1")).toMatchObject({ status: "done", labelIds: ["l1"] });
		expect(r.getState().proposals.size).toBe(0);
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
		applyOps(r, [put(3, issue)]);
		expect(calls).toBe(2);
	});
});
