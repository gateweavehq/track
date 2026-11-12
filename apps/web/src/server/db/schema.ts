// D1 holds identity and the workspace directory. Workspace content lives in each workspace's
// Durable Object (see @gateweave/track-sync-server).
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization, session, user } from "./auth-schema";

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
		/** When asking last failed. The cron goes by it, so those that keep failing wait their turn. */
		lastTriedAt: integer("last_tried_at"),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.organizationId] }),
		index("pendingErasure_organizationId_idx").on(table.organizationId),
		index("pendingErasure_lastTriedAt_idx").on(table.lastTriedAt, table.createdAt),
	],
);

/**
 * "Who runs this server" in docs/architecture.md. One row: who the server's owner is, whether anyone
 * may make an account on it, and whether the OpenID Connect provider's own list counts as the owner's.
 * A migration makes the row, and triggers there hold what it says however an account comes to be made.
 */
export const deployment = sqliteTable(
	"deployment",
	{
		id: integer("id").primaryKey(),
		/** Null only until the first account on a server with none, and if the owner's account is deleted. */
		ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
		signUp: text("sign_up", { enum: ["closed", "open"] }).notNull(),
		/** Whether an account made through the OpenID Connect provider needs no entry on the list. */
		trustProvider: integer("trust_provider", { mode: "boolean" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		check("deployment_one_row", sql`${table.id} = 1`),
		check("deployment_sign_up", sql`${table.signUp} IN ('closed', 'open')`),
	],
);

/**
 * The owner's list of who may make an account while sign-up is closed: a full address, or a domain
 * with a leading `@` that covers that domain and not its subdomains. It holds addresses of people who
 * may have no account yet, and the owner's note on each.
 */
export const signUpAllow = sqliteTable(
	"sign_up_allow",
	{
		entry: text("entry").primaryKey(),
		note: text("note"),
		addedAt: integer("added_at").notNull(),
		/** The owner's user id. Kept as text and not a reference, so it outlives the account. */
		addedBy: text("added_by").notNull(),
	},
	(table) => [
		check("sign_up_allow_lowercase", sql`${table.entry} = lower(${table.entry})`),
		check("sign_up_allow_note", sql`${table.note} IS NULL OR length(${table.note}) <= 200`),
	],
);

/**
 * A minute's leave to make one account, written by the sign-up hook just before an account is made
 * through the provider the owner trusts, and removed once it is made. The trigger
 * `user_needs_a_way_in` cannot see which sign-in made an account, so this is how it tells that one
 * from GitHub and passwords while the owner trusts the provider.
 */
export const signUpPass = sqliteTable("sign_up_pass", {
	email: text("email").primaryKey(),
	expiresAt: integer("expires_at").notNull(),
});

/**
 * The browsers that asked for push notifications, each tied to the session it was turned on in:
 * signing out there, or the session running out, stops it. The endpoint is the push service's
 * address for that browser, and the keys what the message is encrypted to (RFC 8291).
 */
export const pushSubscription = sqliteTable(
	"push_subscription",
	{
		endpoint: text("endpoint").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => session.id, { onDelete: "cascade" }),
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		/** When the browser last saved it, which it does each time Track starts there. */
		savedAt: integer("saved_at").notNull(),
	},
	(table) => [
		index("pushSubscription_userId_idx").on(table.userId),
		index("pushSubscription_sessionId_idx").on(table.sessionId),
	],
);
