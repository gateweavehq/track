import type {
	Activity,
	Comment,
	Issue,
	Label,
	Member,
	Project,
	Proposal,
	Snapshot,
	Team,
} from "@gateweave/track-protocol";
import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as schema from "./db/schema";
import { ChangeSet, currentVersion, type WriteResult } from "./log";

export type Db = DrizzleSqliteDODatabase<typeof schema>;

/** A verified workspace member, as supplied by the app worker, which owns membership. */
export type MemberProfile = Omit<Member, "removedAt" | "proposes">;

export const toTeam = ({ issueCounter: _, ...team }: schema.TeamRow): Team => team;

export const toIssue = ({ fieldStamps: _, deletedAt: __, ...issue }: schema.IssueRow): Issue =>
	issue;

export const toLabel = ({ deletedAt: _, ...label }: schema.LabelRow): Label => label;

export const toProject = ({ deletedAt: _, ...project }: schema.ProjectRow): Project => project;

export const toComment = ({ deletedAt: _, ...comment }: schema.CommentRow): Comment => comment;

export const toActivity = (activity: schema.ActivityRow): Activity => activity;

export const toProposal = ({
	status: _,
	decidedBy: __,
	decidedAt: ___,
	...proposal
}: schema.ProposalRow): Proposal => proposal;

export const toMember = ({ userId, ...member }: schema.MemberRow): Member => ({
	id: userId,
	...member,
});

export function readSnapshot(db: Db): Snapshot {
	return {
		version: currentVersion(db),
		teams: db.select().from(schema.teams).all().map(toTeam),
		issues: db
			.select()
			.from(schema.issues)
			.where(isNull(schema.issues.deletedAt))
			.all()
			.map(toIssue),
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
		members: db.select().from(schema.members).all().map(toMember),
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

/** Marks a member as removed. The row stays so existing references still resolve. */
export function removeMember(db: Db, userId: string, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const row = db
		.update(schema.members)
		.set({ removedAt: now })
		.where(and(eq(schema.members.userId, userId), isNull(schema.members.removedAt)))
		.returning()
		.get();
	if (row) changes.put("member", toMember(row));
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
