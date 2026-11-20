import { and, type Column, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";

export const CONNECT_PREFIX = "track-connect:";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneOlder(
	db: Database,
	table:
		| typeof schema.session
		| typeof schema.verification
		| typeof schema.oauthRefreshToken
		| typeof schema.oauthAccessToken
		| typeof schema.oauthClientAssertion
		| typeof schema.invitation,
	column: Column,
	before: Date,
	condition?: SQL,
) {
	for (;;) {
		const expired = db
			.select({ id: table.id })
			.from(table)
			.where(and(lt(column, before), condition))
			.limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * Deletes what is past its time. Better Auth removes a session or a verification only when something
 * looks it up, so those nobody comes back for would otherwise stay forever: a session holds the
 * address and browser it came from, a verification an abandoned sign-up's code, and an invitation an
 * address that may never have had anything to do with this deployment. The privacy policy states
 * these, so a change here is a change to it.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	await pruneOlder(db, schema.session, schema.session.expiresAt, now);
	await pruneOlder(
		db,
		schema.verification,
		schema.verification.expiresAt,
		now,
		sql`${schema.verification.identifier} NOT GLOB ${CONNECT_PREFIX + "*"}`,
	);
	// Refresh tokens first, because deleting one takes the access tokens made from it along.
	await pruneOlder(db, schema.oauthRefreshToken, schema.oauthRefreshToken.expiresAt, now);
	await pruneOlder(db, schema.oauthAccessToken, schema.oauthAccessToken.expiresAt, now);
	await pruneOlder(db, schema.oauthClientAssertion, schema.oauthClientAssertion.expiresAt, now);
	await pruneOlder(db, schema.invitation, schema.invitation.expiresAt, now);
	await pruneClients(db, now);
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Anyone can register an OAuth client (dynamic registration), and most never get past the consent
 * page. Those with no owner, a day old, that nobody allows and that hold no refresh token that
 * still works are deleted; the cascade takes their tokens and resources. A client someone allows
 * is never touched.
 */
async function pruneClients(db: Database, now: Date) {
	const { oauthClient, oauthConsent, oauthRefreshToken } = schema;
	const unused = db
		.select({ id: oauthClient.id })
		.from(oauthClient)
		.where(
			sql`${isNull(oauthClient.userId)}
				AND ${lt(oauthClient.createdAt, new Date(now.getTime() - DAY))}
				AND NOT EXISTS (SELECT 1 FROM ${oauthConsent} WHERE ${oauthConsent.clientId} = ${oauthClient.clientId})
				AND NOT EXISTS (SELECT 1 FROM ${oauthRefreshToken} WHERE ${oauthRefreshToken.clientId} = ${oauthClient.clientId} AND ${oauthRefreshToken.expiresAt} >= ${now.getTime()})`,
		)
		.limit(BATCH);
	for (;;) {
		const { meta } = await db.delete(oauthClient).where(inArray(oauthClient.id, unused)).run();
		if (meta.changes < BATCH) return;
	}
}
