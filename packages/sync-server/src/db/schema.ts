/**
 * Storage for a single workspace. Each workspace is one Durable Object with its own SQLite
 * database, so no table needs a workspace column.
 */
import {
	type ActivityChange,
	type AgentChangeKind,
	ENTITY_NAMES,
	ISSUE_STATUSES,
	type IssuePriority,
	MEMBER_ROLES,
	PROJECT_STATUSES,
	type ProposedChange,
	type WebhookDelivery,
	type WebhookEventType,
} from "@gateweave/track-protocol";
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
		projectId: text("project_id"),
		creatorId: text("creator_id").notNull(),
		labelIds: text("label_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
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
	(table) => [
		uniqueIndex("issues_team_number_idx").on(table.teamId, table.number),
		index("issues_project_idx").on(table.projectId),
	],
);

/** Deleted labels keep their row, like issues, but are removed from every issue. */
export const labels = sqliteTable("labels", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	color: text("color").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
	deletedAt: integer("deleted_at"),
});

/** Deleted projects keep their row, like labels, but are cleared from every issue. */
export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	status: text("status", { enum: PROJECT_STATUSES }).notNull(),
	leadId: text("lead_id"),
	targetDate: text("target_date"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
	deletedAt: integer("deleted_at"),
});

/** Deleted comments keep their row, like issues. A deleted issue's comments go with it. */
export const comments = sqliteTable(
	"comments",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		authorId: text("author_id").notNull(),
		body: text("body").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		deletedAt: integer("deleted_at"),
	},
	(table) => [index("comments_issue_idx").on(table.issueId)],
);

/**
 * Issue history. Entries are written by issue mutations, rewritten when a later change merges
 * into them, and deleted when a change undoes them. Insertion order (rowid) finds the latest.
 */
export const activities = sqliteTable(
	"activities",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		actorId: text("actor_id").notNull(),
		change: text("change", { mode: "json" }).$type<ActivityChange>().notNull(),
		proposedBy: text("proposed_by"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("activities_issue_idx").on(table.issueId)],
);

/**
 * Agents' proposals. Decided ones keep their row, as the record of who decided, but leave
 * clients. A deleted issue's proposals go with it, like its comments.
 */
export const proposals = sqliteTable(
	"proposals",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		agentId: text("agent_id").notNull(),
		change: text("change", { mode: "json" }).$type<ProposedChange>().notNull(),
		status: text("status", { enum: ["open", "accepted", "dismissed"] }).notNull(),
		decidedBy: text("decided_by"),
		decidedAt: integer("decided_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("proposals_issue_idx").on(table.issueId, table.status)],
);

/**
 * Replica of workspace membership. The app worker owns membership and pushes changes here.
 * `proposes` is the workspace's own: admins set it with `agent.update`, and pushes leave it be.
 */
export const members = sqliteTable("members", {
	userId: text("user_id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull(),
	image: text("image"),
	role: text("role", { enum: MEMBER_ROLES }).notNull(),
	proposes: text("proposes", { mode: "json" })
		.$type<AgentChangeKind[]>()
		.notNull()
		.default(sql`'[]'`),
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

/** Subscriptions to the workspace's events. Admins manage them; see `webhooks.ts`. */
export const webhooks = sqliteTable("webhooks", {
	id: text("id").primaryKey(),
	url: text("url").notNull(),
	events: text("events", { mode: "json" }).$type<WebhookEventType[]>().notNull(),
	teamId: text("team_id"),
	agentId: text("agent_id"),
	/** `whsec_` and base64. Kept as is, since signing needs it. */
	secret: text("secret").notNull(),
	active: integer("active", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * The webhooks' outbox. A change queues its deliveries in its own transaction, so none is lost,
 * and the alarm sends them. Finished deliveries are kept a while, for settings to show.
 */
export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		webhookId: text("webhook_id")
			.notNull()
			.references(() => webhooks.id),
		event: text("event").$type<WebhookDelivery["event"]>().notNull(),
		/** The exact body, which the signature covers. */
		payload: text("payload").notNull(),
		status: text("status", { enum: ["pending", "delivered", "failed"] }).notNull(),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at"),
		responseStatus: integer("response_status"),
		error: text("error"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("webhook_deliveries_due_idx").on(table.status, table.nextAttemptAt),
		index("webhook_deliveries_webhook_idx").on(table.webhookId, table.createdAt),
	],
);

export type TeamRow = typeof teams.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
