import {
	type ActivityChange,
	AGENT_CHANGE_KINDS,
	isAdminRole,
	MAX_LABELS_PER_ISSUE,
	type Mutation,
	type MutationArgs,
	type ProposedChange,
} from "@gateweave/track-protocol";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import {
	decide,
	findOpenProposal,
	openProposals,
	patchOf,
	propose,
	proposesChange,
} from "./proposals";
import { MutationRejected } from "./rejected";
import { indexIssue, indexTeamIssues, unindexIssue } from "./search";
import {
	activeMember,
	type Db,
	toComment,
	toIssue,
	toLabel,
	toMember,
	toProject,
	toTeam,
} from "./state";
import { queueDeliveries } from "./webhooks";

export interface Actor {
	member: schema.MemberRow;
	clientId: string;
}

/**
 * Applies a client mutation. Must run inside a storage transaction so a rejection rolls back
 * every write. Re-applying a mutation id returns the original version without writing again.
 */
export function applyMutation(
	db: Db,
	actor: Actor,
	mutationId: string,
	mutation: Mutation,
	now: number,
): WriteResult {
	const applied = db
		.select()
		.from(schema.appliedMutations)
		.where(eq(schema.appliedMutations.id, mutationId))
		.get();
	if (applied) {
		if (applied.clientId !== actor.clientId) {
			throw new MutationRejected("invalid", "Mutation id was already used by another client");
		}
		return { version: applied.version, ops: [] };
	}

	const changes = new ChangeSet(db, actor.member.userId, now);
	switch (mutation.name) {
		case "team.create":
			createTeam(db, changes, actor, mutation.args);
			break;
		case "team.update":
			updateTeam(db, changes, actor, mutation.args);
			break;
		case "issue.create":
			createIssue(db, changes, actor, mutation.args);
			break;
		case "issue.update":
			updateIssue(db, changes, actor, mutation.args);
			break;
		case "issue.delete":
			deleteIssue(db, changes, mutation.args);
			break;
		case "issue.addLabel":
			addLabel(db, changes, actor, mutation.args);
			break;
		case "issue.removeLabel":
			removeLabel(db, changes, actor, mutation.args);
			break;
		case "label.create":
			createLabel(db, changes, mutation.args);
			break;
		case "label.update":
			updateLabel(db, changes, mutation.args);
			break;
		case "label.delete":
			deleteLabel(db, changes, actor, mutation.args);
			break;
		case "project.create":
			createProject(db, changes, actor, mutation.args);
			break;
		case "project.update":
			updateProject(db, changes, actor, mutation.args);
			break;
		case "project.delete":
			deleteProject(db, changes, actor, mutation.args);
			break;
		case "comment.create":
			createComment(db, changes, actor, mutation.args);
			break;
		case "comment.update":
			updateComment(db, changes, actor, mutation.args);
			break;
		case "comment.delete":
			deleteComment(db, changes, actor, mutation.args);
			break;
		case "agent.update":
			updateAgent(db, changes, actor, mutation.args);
			break;
		case "proposal.accept":
			acceptProposal(db, changes, actor, mutation.args);
			break;
		case "proposal.dismiss":
			dismissProposal(db, changes, actor, mutation.args);
			break;
	}

	const result = changes.result();
	db.insert(schema.appliedMutations)
		.values({ id: mutationId, clientId: actor.clientId, version: result.version, at: now })
		.run();
	const queued = queueDeliveries(db, actor.member, changes.events, result.version, now);
	return { ...result, queued, proposed: changes.proposed };
}

function createTeam(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"team.create">) {
	requireAdmin(actor, "Only workspace admins can manage teams");
	if (findTeam(db, args.id)) throw new MutationRejected("invalid", "Team id already exists");
	assertTeamKeyFree(db, args.key);

	const row: schema.TeamRow = {
		...args,
		issueCounter: 0,
		createdAt: changes.now,
		updatedAt: changes.now,
	};
	db.insert(schema.teams).values(row).run();
	changes.put("team", toTeam(row));
}

function updateTeam(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"team.update">) {
	requireAdmin(actor, "Only workspace admins can manage teams");
	const team = findTeam(db, args.id);
	if (!team) throw new MutationRejected("not_found", "Team not found");
	if (args.patch.key && args.patch.key !== team.key) assertTeamKeyFree(db, args.patch.key, team.id);

	const row = db
		.update(schema.teams)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.teams.id, team.id))
		.returning()
		.get();
	if (row) changes.put("team", toTeam(row));
	// The team's issue keys changed with it.
	if (row && row.key !== team.key) indexTeamIssues(db, team.id);
}

function createIssue(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"issue.create">) {
	const team = findTeam(db, args.teamId);
	if (!team) throw new MutationRejected("not_found", "Team not found");
	if (db.select().from(schema.issues).where(eq(schema.issues.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Issue id already exists");
	}
	assertAssignable(db, args.assigneeId);
	assertProjectLive(db, args.projectId);
	const requested = [...new Set(args.labelIds)];
	for (const labelId of requested) {
		if (!findLiveLabel(db, labelId)) throw new MutationRejected("not_found", "Label not found");
	}

	// What an agent proposes, the issue is made without; the proposals go on it once it exists.
	const held: ProposedChange[] = [];
	const hold = (change: ProposedChange) => {
		if (!proposesChange(actor.member, change)) return false;
		held.push(change);
		return true;
	};
	const status =
		args.status !== "backlog" && hold({ type: "status", to: args.status })
			? "backlog"
			: args.status;
	const priority =
		args.priority !== 0 && hold({ type: "priority", to: args.priority }) ? 0 : args.priority;
	const assigneeId =
		args.assigneeId !== null && hold({ type: "assignee", to: args.assigneeId })
			? null
			: args.assigneeId;
	const projectId =
		args.projectId !== null && hold({ type: "project", to: args.projectId })
			? null
			: args.projectId;
	const labelIds = requested.filter((labelId) => !hold({ type: "label", labelId, added: true }));

	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();

	const row: schema.IssueRow = {
		...args,
		status,
		priority,
		assigneeId,
		projectId,
		labelIds,
		number,
		creatorId: actor.member.userId,
		version: changes.nextVersion,
		// Fields without a stamp were last written at creation, which every client has seen.
		fieldStamps: {},
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.issues).values(row).run();
	indexIssue(db, row.id);
	changes.put("issue", toIssue(row));
	changes.events.push({ type: "issue.created", issue: row });
	for (const change of held) propose(db, changes, row, actor.member.userId, change);
}

/**
 * Field-level optimistic concurrency: each field in the patch is applied unless another client
 * wrote that field after `baseVersion`. A client's own earlier writes never conflict with its
 * later ones, so rapid successive edits from one tab all land. If every field conflicts, the
 * whole mutation is rejected. The fields an agent proposes become proposals instead.
 */
function updateIssue(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"issue.update">,
	proposedBy: string | null = null,
) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (args.patch.assigneeId !== undefined) assertAssignable(db, args.patch.assigneeId);
	if (args.patch.projectId !== undefined) assertProjectLive(db, args.patch.projectId);

	const patch: IssuePatch = {};
	for (const [field, value] of Object.entries(args.patch) as [keyof IssuePatch, never][]) {
		const change = proposedChange(field, value);
		if (change && proposesChange(actor.member, change)) {
			propose(db, changes, issue, actor.member.userId, change);
		} else {
			patch[field] = value;
		}
	}

	const version = changes.nextVersion;
	const accepted: Partial<schema.IssueRow> = {};
	const stamps = { ...issue.fieldStamps };
	let conflicted = false;

	for (const [field, value] of Object.entries(patch) as [keyof IssuePatch, never][]) {
		const stamp = issue.fieldStamps[field];
		if (stamp && stamp.version > args.baseVersion && stamp.clientId !== actor.clientId) {
			conflicted = true;
			continue;
		}
		if (issue[field] === value) continue;
		accepted[field] = value;
		stamps[field] = { version, clientId: actor.clientId };
	}

	if (Object.keys(accepted).length === 0) {
		if (conflicted) {
			throw new MutationRejected("conflict", "Another client changed these fields first");
		}
		return;
	}

	const row = db
		.update(schema.issues)
		.set({ ...accepted, fieldStamps: stamps, version, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.returning()
		.get();
	if (row) {
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue });
	}
	if (accepted.title !== undefined || accepted.description !== undefined) {
		indexIssue(db, issue.id);
	}
	// After the issue's own op, so the issue's version stays the version that wrote it.
	for (const change of issueChanges(issue, accepted)) {
		recordActivity(db, changes, issue, actor.member.userId, change, proposedBy);
	}
}

type IssuePatch = MutationArgs<"issue.update">["patch"];

/** A patch field as a proposal. Manual ordering is never proposed. */
function proposedChange(field: keyof IssuePatch, value: never): ProposedChange | null {
	switch (field) {
		case "title":
			return { type: "title", to: value };
		case "description":
			return { type: "description", to: value };
		case "status":
			return { type: "status", to: value };
		case "priority":
			return { type: "priority", to: value };
		case "assigneeId":
			return { type: "assignee", to: value };
		case "projectId":
			return { type: "project", to: value };
		case "sortOrder":
			return null;
	}
}

/** What a patch changed, as history. Manual ordering is not history. */
function issueChanges(before: schema.IssueRow, patch: Partial<schema.IssueRow>): ActivityChange[] {
	const changes: ActivityChange[] = [];
	if (patch.status !== undefined) {
		changes.push({ type: "status", from: before.status, to: patch.status });
	}
	if (patch.priority !== undefined) {
		changes.push({ type: "priority", from: before.priority, to: patch.priority });
	}
	if (patch.assigneeId !== undefined) {
		changes.push({ type: "assignee", from: before.assigneeId, to: patch.assigneeId });
	}
	if (patch.projectId !== undefined) {
		changes.push({ type: "project", from: before.projectId, to: patch.projectId });
	}
	if (patch.title !== undefined)
		changes.push({ type: "title", from: before.title, to: patch.title });
	if (patch.description !== undefined) changes.push({ type: "description" });
	return changes;
}

/**
 * The issue's comments and history go with it. Their rows stay, like the issue's, but clients are
 * told to drop them, since a snapshot leaves out everything that belongs to a deleted issue.
 */
function deleteIssue(db: Db, changes: ChangeSet, args: MutationArgs<"issue.delete">) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");

	const comments = db
		.select({ id: schema.comments.id })
		.from(schema.comments)
		.where(and(eq(schema.comments.issueId, issue.id), isNull(schema.comments.deletedAt)))
		.all();
	for (const comment of comments) changes.delete("comment", comment.id);
	const activities = db
		.select({ id: schema.activities.id })
		.from(schema.activities)
		.where(eq(schema.activities.issueId, issue.id))
		.all();
	for (const activity of activities) changes.delete("activity", activity.id);
	for (const proposal of openProposals(db, issue.id)) changes.delete("proposal", proposal.id);

	db.update(schema.issues)
		.set({ deletedAt: changes.now, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.run();
	unindexIssue(db, issue.id);
	changes.delete("issue", issue.id);
	changes.events.push({ type: "issue.deleted", issue });
}

/** Labels are sets, so adding one that is already there, or removing one that is not, is a no-op. */
function addLabel(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"issue.addLabel">,
	proposedBy: string | null = null,
) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	if (!findLiveLabel(db, args.labelId)) throw new MutationRejected("not_found", "Label not found");
	const change: ProposedChange = { type: "label", labelId: args.labelId, added: true };
	if (proposesChange(actor.member, change)) {
		propose(db, changes, issue, actor.member.userId, change);
		return;
	}
	if (issue.labelIds.includes(args.labelId)) return;
	if (issue.labelIds.length >= MAX_LABELS_PER_ISSUE) {
		throw new MutationRejected(
			"invalid",
			`An issue can have at most ${MAX_LABELS_PER_ISSUE} labels`,
		);
	}
	writeIssueLabels(db, changes, issue, [...issue.labelIds, args.labelId]);
	recordActivity(db, changes, issue, actor.member.userId, change, proposedBy);
}

function removeLabel(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"issue.removeLabel">,
	proposedBy: string | null = null,
) {
	const issue = findLiveIssue(db, args.id);
	if (!issue) throw new MutationRejected("not_found", "Issue not found");
	const change: ProposedChange = { type: "label", labelId: args.labelId, added: false };
	if (proposesChange(actor.member, change)) {
		propose(db, changes, issue, actor.member.userId, change);
		return;
	}
	if (!issue.labelIds.includes(args.labelId)) return;
	writeIssueLabels(
		db,
		changes,
		issue,
		issue.labelIds.filter((id) => id !== args.labelId),
	);
	recordActivity(db, changes, issue, actor.member.userId, change, proposedBy);
}

function writeIssueLabels(db: Db, changes: ChangeSet, issue: schema.IssueRow, labelIds: string[]) {
	const row = db
		.update(schema.issues)
		.set({ labelIds, version: changes.nextVersion, updatedAt: changes.now })
		.where(eq(schema.issues.id, issue.id))
		.returning()
		.get();
	if (row) {
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue });
	}
}

function createLabel(db: Db, changes: ChangeSet, args: MutationArgs<"label.create">) {
	if (db.select().from(schema.labels).where(eq(schema.labels.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Label id already exists");
	}
	assertLabelNameFree(db, args.name);

	const row: schema.LabelRow = {
		...args,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.labels).values(row).run();
	changes.put("label", toLabel(row));
}

function updateLabel(db: Db, changes: ChangeSet, args: MutationArgs<"label.update">) {
	const label = findLiveLabel(db, args.id);
	if (!label) throw new MutationRejected("not_found", "Label not found");
	if (args.patch.name !== undefined) assertLabelNameFree(db, args.patch.name, label.id);

	const row = db
		.update(schema.labels)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.labels.id, label.id))
		.returning()
		.get();
	if (row) changes.put("label", toLabel(row));
}

/** Removes the label from every issue that has it, then deletes it. Admins only: it is wide. */
function deleteLabel(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"label.delete">) {
	requireAdmin(actor, "Only workspace admins can delete labels");
	const label = findLiveLabel(db, args.id);
	if (!label) throw new MutationRejected("not_found", "Label not found");

	const labeled = db
		.select()
		.from(schema.issues)
		.where(
			and(
				isNull(schema.issues.deletedAt),
				sql`exists (select 1 from json_each(${schema.issues.labelIds}) where value = ${label.id})`,
			),
		)
		.all();
	for (const issue of labeled) {
		writeIssueLabels(
			db,
			changes,
			issue,
			issue.labelIds.filter((id) => id !== label.id),
		);
	}

	db.update(schema.labels)
		.set({ deletedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.labels.id, label.id))
		.run();
	changes.delete("label", label.id);
}

function createProject(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"project.create">,
) {
	requirePerson(actor, "Agents cannot create projects");
	if (db.select().from(schema.projects).where(eq(schema.projects.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Project id already exists");
	}
	assertLead(db, args.leadId);

	const row: schema.ProjectRow = {
		...args,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.projects).values(row).run();
	changes.put("project", toProject(row));
}

function updateProject(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"project.update">,
) {
	requirePerson(actor, "Agents cannot change projects");
	const project = findLiveProject(db, args.id);
	if (!project) throw new MutationRejected("not_found", "Project not found");
	if (args.patch.leadId !== undefined) assertLead(db, args.patch.leadId);

	const changed = (Object.entries(args.patch) as [keyof typeof args.patch, unknown][]).some(
		([field, value]) => project[field] !== value,
	);
	if (!changed) return;
	const row = db
		.update(schema.projects)
		.set({ ...args.patch, updatedAt: changes.now })
		.where(eq(schema.projects.id, project.id))
		.returning()
		.get();
	if (row) changes.put("project", toProject(row));
}

/** Takes the project off every issue in it, then deletes it. Admins only: it is wide. */
function deleteProject(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"project.delete">,
) {
	requireAdmin(actor, "Only workspace admins can delete projects");
	const project = findLiveProject(db, args.id);
	if (!project) throw new MutationRejected("not_found", "Project not found");

	const members = db
		.select()
		.from(schema.issues)
		.where(and(isNull(schema.issues.deletedAt), eq(schema.issues.projectId, project.id)))
		.all();
	for (const issue of members) {
		const row = db
			.update(schema.issues)
			.set({ projectId: null, version: changes.nextVersion, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (row) {
			changes.put("issue", toIssue(row));
			changes.events.push({ type: "issue.updated", issue: row, previous: issue });
		}
	}

	db.update(schema.projects)
		.set({ deletedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.projects.id, project.id))
		.run();
	changes.delete("project", project.id);
}

function createComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.create">,
) {
	if (!findLiveIssue(db, args.issueId)) throw new MutationRejected("not_found", "Issue not found");
	if (db.select().from(schema.comments).where(eq(schema.comments.id, args.id)).get()) {
		throw new MutationRejected("invalid", "Comment id already exists");
	}

	const row: schema.CommentRow = {
		...args,
		authorId: actor.member.userId,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.comments).values(row).run();
	indexIssue(db, row.issueId);
	changes.put("comment", toComment(row));
	changes.events.push({ type: "comment.created", comment: row });
}

/** A comment says what its author said, so nobody else can change it, admins included. */
function updateComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.update">,
) {
	const comment = findLiveComment(db, args.id);
	if (!comment) throw new MutationRejected("not_found", "Comment not found");
	if (comment.authorId !== actor.member.userId) {
		throw new MutationRejected("forbidden", "Only the author can edit a comment");
	}
	if (comment.body === args.body) return;

	const row = db
		.update(schema.comments)
		.set({ body: args.body, updatedAt: changes.now })
		.where(eq(schema.comments.id, comment.id))
		.returning()
		.get();
	indexIssue(db, comment.issueId);
	if (row) {
		changes.put("comment", toComment(row));
		changes.events.push({ type: "comment.updated", comment: row });
	}
}

/** Admins can delete anyone's comment, for moderation. */
function deleteComment(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"comment.delete">,
) {
	const comment = findLiveComment(db, args.id);
	if (!comment) throw new MutationRejected("not_found", "Comment not found");
	if (comment.authorId !== actor.member.userId) {
		requireAdmin(actor, "Only the author or an admin can delete a comment");
	}

	db.update(schema.comments)
		.set({ deletedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.comments.id, comment.id))
		.run();
	indexIssue(db, comment.issueId);
	changes.delete("comment", comment.id);
	changes.events.push({ type: "comment.deleted", comment });
}

/** Sets what an agent proposes instead of making. Its open proposals stay as they are. */
function updateAgent(db: Db, changes: ChangeSet, actor: Actor, args: MutationArgs<"agent.update">) {
	requireAdmin(actor, "Only workspace admins can manage agents");
	const agent = activeMember(db, args.id);
	if (agent?.role !== "agent") throw new MutationRejected("not_found", "Agent not found");
	if (args.patch.proposes === undefined) return;

	// Stored in one order, without repeats, so equal settings compare equal.
	const wanted = new Set(args.patch.proposes);
	const proposes = AGENT_CHANGE_KINDS.filter((kind) => wanted.has(kind));
	if (proposes.join() === agent.proposes.join()) return;
	const row = db
		.update(schema.members)
		.set({ proposes })
		.where(eq(schema.members.userId, agent.userId))
		.returning()
		.get();
	if (row) changes.put("member", toMember(row));
}

/**
 * Makes the proposed change as the person accepting it, through the same handlers as their own
 * edits, with the agent noted in the history. It is made against the issue as it is now:
 * accepting is a decision taken looking at it.
 */
function acceptProposal(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"proposal.accept">,
) {
	requirePerson(actor, "Only people can accept proposals");
	const proposal = findOpenProposal(db, args.id);
	if (!proposal) {
		throw new MutationRejected("not_found", "That proposal was already accepted or dismissed");
	}
	const { change, agentId, issueId } = proposal;
	if (change.type === "label") {
		const labelArgs = { id: issueId, labelId: change.labelId };
		if (change.added) addLabel(db, changes, actor, labelArgs, agentId);
		else removeLabel(db, changes, actor, labelArgs, agentId);
	} else {
		const issue = findLiveIssue(db, issueId);
		if (!issue) throw new MutationRejected("not_found", "Issue not found");
		const patch = patchOf(change);
		updateIssue(db, changes, actor, { id: issueId, baseVersion: issue.version, patch }, agentId);
	}
	decide(db, changes, proposal, "accepted", actor.member.userId);
}

function dismissProposal(
	db: Db,
	changes: ChangeSet,
	actor: Actor,
	args: MutationArgs<"proposal.dismiss">,
) {
	requirePerson(actor, "Only people can dismiss proposals");
	const proposal = findOpenProposal(db, args.id);
	if (!proposal) {
		throw new MutationRejected("not_found", "That proposal was already accepted or dismissed");
	}
	decide(db, changes, proposal, "dismissed", actor.member.userId);
}

function requireAdmin(actor: Actor, message: string) {
	if (!isAdminRole(actor.member.role)) throw new MutationRejected("forbidden", message);
}

/** Proposals are how people stay in control of agents, so no agent decides on one. */
function requirePerson(actor: Actor, message: string) {
	if (actor.member.role === "agent") throw new MutationRejected("forbidden", message);
}

function findTeam(db: Db, id: string) {
	return db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
}

function findLiveIssue(db: Db, id: string) {
	const issue = db.select().from(schema.issues).where(eq(schema.issues.id, id)).get();
	return issue && issue.deletedAt === null ? issue : undefined;
}

/** A comment is live while it and its issue are. */
function findLiveComment(db: Db, id: string) {
	const comment = db
		.select()
		.from(schema.comments)
		.where(and(eq(schema.comments.id, id), isNull(schema.comments.deletedAt)))
		.get();
	return comment && findLiveIssue(db, comment.issueId) ? comment : undefined;
}

function findLiveProject(db: Db, id: string) {
	return db
		.select()
		.from(schema.projects)
		.where(and(eq(schema.projects.id, id), isNull(schema.projects.deletedAt)))
		.get();
}

function findLiveLabel(db: Db, id: string) {
	return db
		.select()
		.from(schema.labels)
		.where(and(eq(schema.labels.id, id), isNull(schema.labels.deletedAt)))
		.get();
}

/** Compared in JavaScript, because SQLite's lower() only folds ASCII. */
function assertLabelNameFree(db: Db, name: string, exceptLabelId?: string) {
	const folded = name.toLowerCase();
	const taken = db
		.select({ id: schema.labels.id, name: schema.labels.name })
		.from(schema.labels)
		.where(isNull(schema.labels.deletedAt))
		.all()
		.some((label) => label.id !== exceptLabelId && label.name.toLowerCase() === folded);
	if (taken) throw new MutationRejected("conflict", `A label named "${name}" already exists`);
}

function assertTeamKeyFree(db: Db, key: string, exceptTeamId?: string) {
	const taken = db
		.select({ id: schema.teams.id })
		.from(schema.teams)
		.where(
			exceptTeamId
				? and(eq(schema.teams.key, key), ne(schema.teams.id, exceptTeamId))
				: eq(schema.teams.key, key),
		)
		.get();
	if (taken) throw new MutationRejected("conflict", `Team key ${key} is already in use`);
}

function assertProjectLive(db: Db, projectId: string | null) {
	if (projectId !== null && !findLiveProject(db, projectId)) {
		throw new MutationRejected("not_found", "Project not found");
	}
}

/** A project is led by a person: an agent proposes and works, it does not lead. */
function assertLead(db: Db, leadId: string | null) {
	if (leadId === null) return;
	const lead = activeMember(db, leadId);
	if (!lead || lead.role === "agent") {
		throw new MutationRejected("invalid", "Lead is not a person in this workspace");
	}
}

function assertAssignable(db: Db, assigneeId: string | null) {
	if (assigneeId !== null && !activeMember(db, assigneeId)) {
		throw new MutationRejected("invalid", "Assignee is not a workspace member");
	}
}
