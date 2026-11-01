// D1 holds identity and the workspace directory. Workspace content lives in each workspace's
// Durable Object (see @gateweave/track-sync-server).
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
