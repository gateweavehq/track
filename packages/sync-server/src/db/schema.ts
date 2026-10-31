/**
 * Storage for a single workspace. Each workspace is one Durable Object with its own SQLite
 * database, so no table needs a workspace column.
 */
import {
	type ActivityChange,
	type ActivitySource,
	type AgentChangeKind,
	type CycleSettings,
	ENTITY_NAMES,
	type InboxEvent,
	ISSUE_LAYOUTS,
	ISSUE_STATUSES,
	type IssueDisplay,
	type IssueFilters,
	type IssuePriority,
	MEMBER_ROLES,
	type NotificationKind,
	type NotificationLevel,
	PROJECT_STATUSES,
	type ProposedChange,
	PULL_REQUEST_STATES,
	RELATION_TYPES,
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
	cycles: text("cycles", { mode: "json" }).$type<CycleSettings>(),
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
		cycleId: text("cycle_id"),
		parentId: text("parent_id"),
		startDate: text("start_date"),
		dueDate: text("due_date"),
		estimate: integer("estimate"),
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
		index("issues_cycle_idx").on(table.cycleId),
		index("issues_parent_idx").on(table.parentId),
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

/**
 * Teams' cycles, which the server schedules. Completed cycles stay. One that never started is
 * deleted when its team turns cycles off, leaving no row, like a relation.
 */
export const cycles = sqliteTable(
	"cycles",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => teams.id),
		number: integer("number").notNull(),
		name: text("name"),
		startsOn: text("starts_on").notNull(),
		endsOn: text("ends_on").notNull(),
		completedAt: integer("completed_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [uniqueIndex("cycles_team_number_idx").on(table.teamId, table.number)],
);

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
		source: text("source", { mode: "json" }).$type<ActivitySource>(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("activities_issue_idx").on(table.issueId)],
);

/**
 * Links between issues. Unlike most rows, a relation leaves no row behind: deleting it, or either of
 * its issues, removes it, and the history of both issues keeps the record.
 */
export const relations = sqliteTable(
	"relations",
	{
		id: text("id").primaryKey(),
		type: text("type", { enum: RELATION_TYPES }).notNull(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		relatedIssueId: text("related_issue_id")
			.notNull()
			.references(() => issues.id),
		creatorId: text("creator_id").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		index("relations_issue_idx").on(table.issueId),
		index("relations_related_issue_idx").on(table.relatedIssueId),
	],
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
/** Saved views. Deleting one removes its row; nothing refers to a view. */
export const views = sqliteTable("views", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	ownerId: text("owner_id"),
	layout: text("layout", { enum: ISSUE_LAYOUTS }).notNull(),
	filters: text("filters", { mode: "json" }).$type<IssueFilters>().notNull(),
	display: text("display", { mode: "json" }).$type<IssueDisplay>(),
	creatorId: text("creator_id").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

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

/**
 * Members' subscriptions to issues. Private: their ops and rows go to the member alone. A deleted
 * issue's subscriptions go with it.
 */
export const subscriptions = sqliteTable(
	"subscriptions",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		memberId: text("member_id").notNull(),
		subscribed: integer("subscribed", { mode: "boolean" }).notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("subscriptions_issue_idx").on(table.issueId),
		index("subscriptions_member_idx").on(table.memberId),
	],
);

/** Members' inboxes, one item per member and issue. Private, like subscriptions. */
export const inboxItems = sqliteTable(
	"inbox_items",
	{
		id: text("id").primaryKey(),
		issueId: text("issue_id")
			.notNull()
			.references(() => issues.id),
		memberId: text("member_id").notNull(),
		event: text("event", { mode: "json" }).$type<InboxEvent>().notNull(),
		actorId: text("actor_id").notNull(),
		unread: integer("unread").notNull(),
		updatedAt: integer("updated_at").notNull(),
		snoozedUntil: integer("snoozed_until"),
		archivedAt: integer("archived_at"),
		/**
		 * When the item is to be emailed, if news the member wants by email is waiting. Reading,
		 * archiving or snoozing it clears this. Never sent to clients.
		 */
		emailAt: integer("email_at"),
	},
	(table) => [
		index("inbox_items_issue_idx").on(table.issueId),
		index("inbox_items_member_idx").on(table.memberId),
		index("inbox_items_email_idx").on(table.emailAt),
	],
);

/**
 * Members' choices of what reaches their inbox and email, and when they were last emailed. A
 * member without a row has the defaults. Private, and never sent to clients: settings read them
 * over RPC.
 */
export const notificationSettings = sqliteTable("notification_settings", {
	memberId: text("member_id").primaryKey(),
	/** The kinds they changed. The rest follow the defaults, which new kinds start from too. */
	levels: text("levels", { mode: "json" })
		.$type<Partial<Record<NotificationKind, NotificationLevel>>>()
		.notNull(),
	emailedAt: integer("emailed_at"),
	updatedAt: integer("updated_at").notNull(),
});

/** Ordered log of every change. `version` is the workspace-wide sequence number. */
export const oplog = sqliteTable("oplog", {
	version: integer("version").primaryKey(),
	entity: text("entity", { enum: ENTITY_NAMES }).notNull(),
	entityId: text("entity_id").notNull(),
	op: text("op", { enum: ["put", "delete"] }).notNull(),
	data: text("data", { mode: "json" }).$type<unknown>(),
	actorId: text("actor_id"),
	/** The only member a private op is for; null for ops every member gets. */
	audience: text("audience"),
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
 * Pull requests that mention the workspace's issues, as GitHub connections report them. A pull
 * request that mentions none is not kept.
 */
export const pullRequests = sqliteTable("pull_requests", {
	id: text("id").primaryKey(),
	repository: text("repository").notNull(),
	number: integer("number").notNull(),
	title: text("title").notNull(),
	url: text("url").notNull(),
	state: text("state", { enum: PULL_REQUEST_STATES }).notNull(),
	branch: text("branch").notNull(),
	author: text("author"),
	issueIds: text("issue_ids", { mode: "json" }).$type<string[]>().notNull(),
	closingIssueIds: text("closing_issue_ids", { mode: "json" }).$type<string[]>().notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/** Webhooks on GitHub that report to the workspace. The secret checks each delivery. */
export const githubConnections = sqliteTable("github_connections", {
	id: text("id").primaryKey(),
	secret: text("secret").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: integer("created_at").notNull(),
	lastDeliveryAt: integer("last_delivery_at"),
	lastEvent: text("last_event"),
	lastRepository: text("last_repository"),
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
export type CycleRow = typeof cycles.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
export type ViewRow = typeof views.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type InboxItemRow = typeof inboxItems.$inferSelect;
export type NotificationSettingsRow = typeof notificationSettings.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type GitHubConnectionRow = typeof githubConnections.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
