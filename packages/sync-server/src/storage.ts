import { eq } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";

// How many bytes of attached files a workspace keeps, for its quota. The files live in R2,
// outside this object, but uploads to one workspace pass through here one at a time, so a
// reservation is atomic: two uploads cannot both take the last of the space. The count starts
// from what R2 holds the first time it is needed, as files were attached before it existed.
// Without a quota nothing is counted, so the gateway forgets the count then, and turning a
// quota on again starts it from R2 once more instead of from a total that missed uploads.

const KEY = "file_bytes";

export type StorageReservation =
	| { ok: true; used: number }
	| { ok: false; used: number }
	/** The count has not started: list the workspace's files and pass their total as `seed`. */
	| { needsSeed: true };

export function reserveFileStorage(
	db: Db,
	{ bytes, limit, seed }: { bytes: number; limit: number; seed?: number },
): StorageReservation {
	const row = db.select().from(schema.meta).where(eq(schema.meta.key, KEY)).get();
	const current = row ? Number(row.value) : seed;
	if (current === undefined || !Number.isFinite(current)) return { needsSeed: true };
	if (current + bytes > limit) {
		if (!row) write(db, current);
		return { ok: false, used: current };
	}
	write(db, current + bytes);
	return { ok: true, used: current + bytes };
}

/** Gives back what an upload reserved and did not store. */
export function releaseFileStorage(db: Db, bytes: number): void {
	const row = db.select().from(schema.meta).where(eq(schema.meta.key, KEY)).get();
	if (!row) return;
	write(db, Math.max(0, Number(row.value) - bytes));
}

/** Drops the count, so that the next reservation starts it from the bucket again. */
export function forgetFileStorage(db: Db): void {
	db.delete(schema.meta).where(eq(schema.meta.key, KEY)).run();
}

function write(db: Db, bytes: number) {
	const value = String(bytes);
	db.insert(schema.meta)
		.values({ key: KEY, value })
		.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
		.run();
}
