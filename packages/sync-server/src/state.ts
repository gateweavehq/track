import type {
	Activity,
	Comment,
	Cycle,
	InboxItem,
	Issue,
	IssueRelation,
	Label,
	Member,
	Project,
	Proposal,
	PullRequest,
	SavedView,
	Snapshot,
	Subscription,
	Team,
} from "@gateweave/track-protocol";
import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as schema from "./db/schema";
import { forgetMember } from "./inbox";
import { ChangeSet, currentVersion, type WriteResult } from "./log";

export type Db = DrizzleSqliteDODatabase<typeof schema>;

/** A verified workspace member, as supplied by the app worker, which owns membership. */
export type MemberProfile = Omit<Member, "removedAt" | "proposes">;

export const toTeam = ({ issueCounter: _, ...team }: schema.TeamRow): Team => team;

export const toIssue = ({ fieldStamps: _, deletedAt: __, ...issue }: schema.IssueRow): Issue =>
	issue;

export const toLabel = ({ deletedAt: _, ...label }: schema.LabelRow): Label => label;

export const toProject = ({ deletedAt: _, ...project }: schema.ProjectRow): Project => project;

export const toCycle = (cycle: schema.CycleRow): Cycle => cycle;

export const toComment = ({ deletedAt: _, ...comment }: schema.CommentRow): Comment => comment;

export const toActivity = (activity: schema.ActivityRow): Activity => activity;

export const toProposal = ({
	status: _,
	decidedBy: __,
	decidedAt: ___,
	...proposal
}: schema.ProposalRow): Proposal => proposal;

export const toRelation = (relation: schema.RelationRow): IssueRelation => relation;

export const toView = (view: schema.ViewRow): SavedView => view;

export const toPullRequest = (pullRequest: schema.PullRequestRow): PullRequest => pullRequest;

export const toMember = ({ userId, ...member }: schema.MemberRow): Member => ({
	id: userId,
	...member,
});

export const toSubscription = (subscription: schema.SubscriptionRow): Subscription => subscription;

export const toInboxItem = ({ emailAt: _, ...item }: schema.InboxItemRow): InboxItem => item;

/**
 * The workspace as `memberId` sees it: everything, with their own subscriptions and inbox. Those
 * of deleted issues are removed with them.
 */
export function readSnapshot(db: Db, memberId: string): Snapshot {
	const issues = db
		.select()
		.from(schema.issues)
		.where(isNull(schema.issues.deletedAt))
		.all()
		.map(toIssue);
	const live = new Set(issues.map((issue) => issue.id));
	return {
		version: currentVersion(db),
		teams: db.select().from(schema.teams).all().map(toTeam),
		issues,
		labels: db
			.select()
			.from(schema.labels)
			.where(isNull(schema.labels.deletedAt))
			.all()
			.map(toLabel),
		projects: db
			.select()
			.from(schema.projects)
			.where(isNull(schema.projects.deletedAt))
			.orderBy(asc(schema.projects.createdAt), asc(schema.projects.id))
			.all()
			.map(toProject),
		cycles: db
			.select()
			.from(schema.cycles)
			.orderBy(asc(schema.cycles.teamId), asc(schema.cycles.number))
			.all()
			.map(toCycle),
		comments: db
			.select(getTableColumns(schema.comments))
			.from(schema.comments)
			.innerJoin(schema.issues, eq(schema.issues.id, schema.comments.issueId))
			.where(and(isNull(schema.comments.deletedAt), isNull(schema.issues.deletedAt)))
			.orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
			.all()
			.map(toComment),
		activities: db
			.select(getTableColumns(schema.activities))
			.from(schema.activities)
			.innerJoin(schema.issues, eq(schema.issues.id, schema.activities.issueId))
			.where(isNull(schema.issues.deletedAt))
			// Insertion order, which breaks ties between entries written in the same millisecond.
			.orderBy(sql`${schema.activities}.rowid`)
			.all()
			.map(toActivity),
		proposals: db
			.select(getTableColumns(schema.proposals))
			.from(schema.proposals)
			.innerJoin(schema.issues, eq(schema.issues.id, schema.proposals.issueId))
			.where(and(eq(schema.proposals.status, "open"), isNull(schema.issues.deletedAt)))
			.orderBy(asc(schema.proposals.createdAt), asc(schema.proposals.id))
			.all()
			.map(toProposal),
		// Deleting an issue removes its relations, so every one that is left joins live issues.
		relations: db
			.select()
			.from(schema.relations)
			.orderBy(asc(schema.relations.createdAt), asc(schema.relations.id))
			.all()
			.map(toRelation),
		views: db
			.select()
			.from(schema.views)
			.orderBy(asc(schema.views.createdAt), asc(schema.views.id))
			.all()
			.map(toView),
		members: db.select().from(schema.members).all().map(toMember),
		subscriptions: db
			.select()
			.from(schema.subscriptions)
			.where(eq(schema.subscriptions.memberId, memberId))
			.all()
			.map(toSubscription),
		inbox: db
			.select()
			.from(schema.inboxItems)
			.where(eq(schema.inboxItems.memberId, memberId))
			.all()
			.map(toInboxItem),
		pullRequests: db
			.select()
			.from(schema.pullRequests)
			.orderBy(asc(schema.pullRequests.createdAt), asc(schema.pullRequests.id))
			.all()
			.filter((pullRequest) => pullRequest.issueIds.some((id) => live.has(id)))
			.map(toPullRequest),
	};
}

export function activeMember(db: Db, userId: string): schema.MemberRow | undefined {
	return db
		.select()
		.from(schema.members)
		.where(and(eq(schema.members.userId, userId), isNull(schema.members.removedAt)))
		.get();
}

/** Inserts or refreshes a member. Emits an op only when something visible changed. */
export function upsertMember(db: Db, profile: MemberProfile, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const existing = db
		.select()
		.from(schema.members)
		.where(eq(schema.members.userId, profile.id))
		.get();
	const row: schema.MemberRow = {
		userId: profile.id,
		name: profile.name,
		email: profile.email,
		image: profile.image,
		role: profile.role,
		// Only an agent proposes, so someone who is no longer one proposes nothing.
		proposes: profile.role === "agent" ? (existing?.proposes ?? []) : [],
		removedAt: null,
	};
	if (existing && sameMember(existing, row)) return changes.result();

	db.insert(schema.members)
		.values(row)
		.onConflictDoUpdate({ target: schema.members.userId, set: row })
		.run();
	changes.put("member", toMember(row));
	return changes.result();
}

/**
 * Marks a member as removed. The row stays so existing references still resolve; their
 * subscriptions and inbox go.
 */
export function removeMember(db: Db, userId: string, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const row = db
		.update(schema.members)
		.set({ removedAt: now })
		.where(and(eq(schema.members.userId, userId), isNull(schema.members.removedAt)))
		.returning()
		.get();
	if (row) {
		changes.put("member", toMember(row));
		forgetMember(db, changes, userId);
	}
	return changes.result();
}

function sameMember(a: schema.MemberRow, b: schema.MemberRow): boolean {
	return (
		a.name === b.name &&
		a.email === b.email &&
		a.image === b.image &&
		a.role === b.role &&
		a.proposes.join() === b.proposes.join() &&
		a.removedAt === b.removedAt
	);
}
