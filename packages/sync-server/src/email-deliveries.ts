import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import type { Db } from "./state";

/**
 * One email as the email gateway identifies it across deliveries: a hash of the sender's own
 * headers and the address it came to. Email Routing delivers at least once, so a mail that was
 * filed can arrive again. Its id is kept with the applied mutations, as GitHub's deliveries are,
 * and for as long. Recorded, it is longer than any client's mutation id may be, so no client can
 * claim one first.
 */
export const emailDeliveryId = z.string().regex(/^[0-9a-f]{64}$/);

const CLIENT_ID = "email";

function recordId(deliveryId: string): string {
	return `email:${deliveryId}`;
}

/** Whether the mail with this id has been filed already. */
export function wasDelivered(db: Db, deliveryId: string): boolean {
	const row = db
		.select({ id: schema.appliedMutations.id })
		.from(schema.appliedMutations)
		.where(eq(schema.appliedMutations.id, recordId(deliveryId)))
		.get();
	return row !== undefined;
}

/** Records that the mail with this id was filed, in the write that filed it. */
export function recordDelivery(db: Db, deliveryId: string, version: number, now: number): void {
	db.insert(schema.appliedMutations)
		.values({ id: recordId(deliveryId), clientId: CLIENT_ID, version, at: now })
		.run();
}
