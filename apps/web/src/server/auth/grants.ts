import { and, eq, max } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";

/**
 * What a person lets AI assistants do as them: the OAuth clients they approved on the consent page.
 * `/mcp` checks these on every call, and the account page lists and ends them. Better Auth's own
 * routes for this stay closed (`disabledPaths`), so everything that reads or deletes a grant is here.
 */

export interface Grant {
	clientId: string;
	/** What the app called itself when it registered. Any app can call itself anything. */
	name: string | null;
	/** The first address the app sends the person back to. */
	redirectUri: string | null;
	scopes: string[];
	/** When the person allowed it, or allowed it again. */
	allowedAt: number;
	/**
	 * The last time it traded a refresh token for a new one, which it does about once an hour while
	 * it works. Null when it never has: an access token alone is verified without the database.
	 */
	lastUsedAt: number | null;
}

/**
 * A list stored as JSON text. Better Auth writes the array as a string and the JSON column
 * encodes that again, so what comes back may be the array or its text.
 */
function strings(value: unknown): string[] {
	let list = value;
	if (typeof list === "string") {
		try {
			list = JSON.parse(list);
		} catch {
			return [];
		}
	}
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/** The person's grants, the most recently used first. Never anything that could be a token. */
export async function listGrants(db: Database, userId: string): Promise<Grant[]> {
	const consents = await db
		.select({
			clientId: schema.oauthConsent.clientId,
			scopes: schema.oauthConsent.scopes,
			createdAt: schema.oauthConsent.createdAt,
			updatedAt: schema.oauthConsent.updatedAt,
			name: schema.oauthClient.name,
			redirectUris: schema.oauthClient.redirectUris,
		})
		.from(schema.oauthConsent)
		.innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
		.where(eq(schema.oauthConsent.userId, userId));
	const used = await db
		.select({
			clientId: schema.oauthRefreshToken.clientId,
			at: max(schema.oauthRefreshToken.rotatedAt),
		})
		.from(schema.oauthRefreshToken)
		.where(eq(schema.oauthRefreshToken.userId, userId))
		.groupBy(schema.oauthRefreshToken.clientId);
	const lastUsed = new Map(used.map(({ clientId, at }) => [clientId, at]));

	const grants = new Map<string, Grant>();
	for (const consent of consents) {
		const allowedAt = Math.max(consent.createdAt.getTime(), consent.updatedAt.getTime());
		const rotated = lastUsed.get(consent.clientId);
		const lastUsedAt = rotated ? new Date(rotated).getTime() : null;
		const grant: Grant = {
			clientId: consent.clientId,
			name: consent.name?.trim() || null,
			redirectUri: strings(consent.redirectUris)[0] ?? null,
			scopes: strings(consent.scopes),
			allowedAt,
			lastUsedAt,
		};
		const seen = grants.get(consent.clientId);
		if (!seen || seen.allowedAt < allowedAt) grants.set(consent.clientId, grant);
	}
	return [...grants.values()].sort(
		(a, b) => (b.lastUsedAt ?? b.allowedAt) - (a.lastUsedAt ?? a.allowedAt),
	);
}

/**
 * Whether the person still allows this client to use `scope`. One indexed read (`user_id`, a
 * person has a handful of consents).
 */
export async function hasGrant(
	db: Database,
	userId: string,
	clientId: string,
	scope: string,
): Promise<boolean> {
	const rows = await db
		.select({ scopes: schema.oauthConsent.scopes })
		.from(schema.oauthConsent)
		.where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)));
	return rows.some((row) => strings(row.scopes).includes(scope));
}

/**
 * Ends the person's grant to a client at once: its refresh tokens, its access tokens and the
 * consent, in one batch, so no half of it can stay. Only this person's rows go. Returns false, and
 * deletes nothing, when they have no grant for it, the same as for a client that does not exist.
 */
export async function takeBack(db: Database, userId: string, clientId: string): Promise<boolean> {
	const [consent] = await db
		.select({ id: schema.oauthConsent.id })
		.from(schema.oauthConsent)
		.where(and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)))
		.limit(1);
	if (!consent) return false;
	await db.batch([
		db
			.delete(schema.oauthAccessToken)
			.where(
				and(
					eq(schema.oauthAccessToken.userId, userId),
					eq(schema.oauthAccessToken.clientId, clientId),
				),
			),
		db
			.delete(schema.oauthRefreshToken)
			.where(
				and(
					eq(schema.oauthRefreshToken.userId, userId),
					eq(schema.oauthRefreshToken.clientId, clientId),
				),
			),
		db
			.delete(schema.oauthConsent)
			.where(
				and(eq(schema.oauthConsent.userId, userId), eq(schema.oauthConsent.clientId, clientId)),
			),
	]);
	return true;
}
