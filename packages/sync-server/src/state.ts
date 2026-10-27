import type { Issue, Member, Snapshot, Team } from "@tangent/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as schema from "./db/schema";
import { ChangeSet, currentVersion, type WriteResult } from "./log";

export type Db = DrizzleSqliteDODatabase<typeof schema>;

/** A verified workspace member, as supplied by the app worker. */
export type MemberProfile = Omit<Member, "removedAt">;

export const toTeam = ({ issueCounter: _, ...team }: schema.TeamRow): Team => team;

export const toIssue = ({ fieldStamps: _, deletedAt: __, ...issue }: schema.IssueRow): Issue =>
	issue;

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
	const row: schema.MemberRow = {
		userId: profile.id,
		name: profile.name,
		email: profile.email,
		image: profile.image,
		role: profile.role,
		removedAt: null,
	};
	const existing = db
		.select()
		.from(schema.members)
		.where(eq(schema.members.userId, row.userId))
		.get();
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
		a.removedAt === b.removedAt
	);
}
