// D1 holds identity and the workspace directory. Workspace content lives in each workspace's
// Durable Object (see @gateweave/track-sync-server).
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization } from "./auth-schema";

export * from "./auth-schema";

/**
 * Which workspace each installation of the deployment's GitHub App belongs to, and its connection
 * there, so the app's deliveries, which all come to one address, reach it. An installation
 * belongs to one workspace at a time.
 */
export const githubInstallation = sqliteTable(
	"github_installation",
	{
		installationId: text("installation_id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		connectionId: text("connection_id").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("githubInstallation_organizationId_idx").on(table.organizationId)],
);

/**
 * The workspaces someone has left, ids only, because each keeps their name on what they did there
 * and deleting their account has to reach those as well as the ones they are still in. A trigger
 * writes these, so every way of leaving counts.
 */
export const formerMember = sqliteTable(
	"former_member",
	{
		userId: text("user_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.organizationId] }),
		index("formerMember_organizationId_idx").on(table.organizationId),
	],
);

/**
 * Workspaces that still have to forget someone whose account is gone. Deleting the account writes
 * these in the same transaction, a row goes once its workspace has answered, and the daily cron
 * asks again for any that did not. Nothing else would ever notice one that was missed.
 */
export const pendingErasure = sqliteTable(
	"pending_erasure",
	{
		userId: text("user_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.organizationId] }),
		index("pendingErasure_organizationId_idx").on(table.organizationId),
		index("pendingErasure_createdAt_idx").on(table.createdAt),
	],
);
