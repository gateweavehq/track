/**
 * Storage for a single workspace. Each workspace is one Durable Object with its own SQLite
 * database, so no table needs a workspace column.
 */
import { ENTITY_NAMES, ISSUE_STATUSES, type IssuePriority, MEMBER_ROLES } from "@tangent/protocol";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Which write last touched a field. Used to detect concurrent edits to the same field. */
export interface FieldStamp {
	version: number;
	clientId: string;
}

export const teams = sqliteTable("teams", {
	id: text("id").primaryKey(),
	key: text("key").notNull().unique(),
	name: text("name").notNull(),
	issueCounter: integer("issue_counter").notNull().default(0),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const issues = sqliteTable(
	"issues",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id),
		number: integer("number").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status", { enum: ISSUE_STATUSES }).notNull(),
		priority: integer("priority").$type<IssuePriority>().notNull(),
		assigneeId: text("assignee_id"),
		creatorId: text("creator_id").notNull(),
		sortOrder: text("sort_order").notNull(),
		version: integer("version").notNull(),
		fieldStamps: text("field_stamps", { mode: "json" })
			.$type<Record<string, FieldStamp>>()
			.notNull()
			.default(sql`'{}'`),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		deletedAt: integer("deleted_at"),
	},
	(table) => [uniqueIndex("issues_team_number_idx").on(table.teamId, table.number)],
);

/** Replica of workspace membership. The app worker owns membership and pushes changes here. */
export const members = sqliteTable("members", {
	userId: text("user_id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull(),
	image: text("image"),
	role: text("role", { enum: MEMBER_ROLES }).notNull(),
	removedAt: integer("removed_at"),
});

/** Ordered log of every change. `version` is the workspace-wide sequence number. */
export const oplog = sqliteTable("oplog", {
	version: integer("version").primaryKey(),
	entity: text("entity", { enum: ENTITY_NAMES }).notNull(),
	entityId: text("entity_id").notNull(),
	op: text("op", { enum: ["put", "delete"] }).notNull(),
	data: text("data", { mode: "json" }).$type<unknown>(),
	actorId: text("actor_id"),
	at: integer("at").notNull(),
});

/** Mutations already applied, so client retries are idempotent. Pruned with the oplog. */
export const appliedMutations = sqliteTable(
	"applied_mutations",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id").notNull(),
		version: integer("version").notNull(),
		at: integer("at").notNull(),
	},
	(table) => [index("applied_mutations_at_idx").on(table.at)],
);

export const meta = sqliteTable("meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export type TeamRow = typeof teams.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
