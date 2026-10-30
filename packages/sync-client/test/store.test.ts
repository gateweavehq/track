import type {
	Issue,
	Member,
	Op,
	Project,
	Proposal,
	Snapshot,
	Team,
} from "@gateweave/track-protocol";
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
	projectId: null,
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
	comments: [],
	activities: [],
	proposals: [],
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
				projectId: null,
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
					projectId: null,
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
			proposes: [],
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
					proposedBy: null,
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
		r.applyOps([
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

		r.applyOps([
			{ version: 5, entity: "member", id: "alice", op: "put", data: member("alice", "admin") },
		]);
		expect(r.getState().members.get("bot")?.proposes).toEqual(["status", "labels"]);
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
			r.applyOps([putProject(3, project), putProject(4, confirmed)]);
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
			r.applyOps([
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
			r.applyOps([putMember(3, person("alice", "admin")), putProject(4, project)]);
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
			r.applyOps([
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
		r.applyOps([
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
		r.applyOps([
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
		r.applyOps([put(3, issue)]);
		expect(calls).toBe(2);
	});
});
