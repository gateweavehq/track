import { KEYS_PER_SOURCE } from "@gateweave/track-protocol";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";

const { sourceKey, organization, workspaceLocation } = schema;
const keyPattern = /^gws_[A-Za-z0-9_-]{43}$/;

async function digest(key: string) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Even an absent credential takes the same indexed D1 read. No key has the empty hash. */
export async function findSourceByKey(db: Database, key: string | null) {
	const hash = key !== null && keyPattern.test(key) ? await digest(key) : "";
	return (
		(await db
			.select({
				sourceId: sourceKey.sourceId,
				workspaceId: organization.id,
				slug: organization.slug,
				jurisdiction: workspaceLocation.jurisdiction,
			})
			.from(sourceKey)
			.innerJoin(organization, eq(organization.id, sourceKey.organizationId))
			.leftJoin(workspaceLocation, eq(workspaceLocation.workspaceId, organization.id))
			.where(eq(sourceKey.hash, hash))
			.get()) ?? null
	);
}

export function sourceKeys(db: Database, workspaceId: string) {
	return db
		.select({ id: sourceKey.id, sourceId: sourceKey.sourceId, start: sourceKey.start })
		.from(sourceKey)
		.where(eq(sourceKey.organizationId, workspaceId))
		.all();
}

export async function makeSourceKey(db: Database, workspaceId: string, sourceId: string) {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const secret =
		"gws_" +
		btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	const hash = await digest(secret);
	const id = crypto.randomUUID();
	// Checking the count and inserting in one statement keeps simultaneous rotations inside the limit.
	const result =
		await db.run(sql`insert into ${sourceKey} (id, organization_id, source_id, hash, start)
		select ${id}, ${workspaceId}, ${sourceId}, ${hash}, ${secret.slice(0, 12)}
		where (select count(*) from ${sourceKey} where ${sourceKey.organizationId} = ${workspaceId}
			and ${sourceKey.sourceId} = ${sourceId}) < ${KEYS_PER_SOURCE}`);
	return result.meta.changes === 1 ? { id, secret } : null;
}

export function removeSourceKeys(db: Database, workspaceId: string, sourceId: string, id?: string) {
	return db
		.delete(sourceKey)
		.where(
			and(
				eq(sourceKey.organizationId, workspaceId),
				eq(sourceKey.sourceId, sourceId),
				id === undefined ? undefined : eq(sourceKey.id, id),
			),
		)
		.run();
}
