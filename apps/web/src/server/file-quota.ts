import { env } from "cloudflare:workers";
import { db } from "./auth";
import { findWorkspaceStub } from "./workspaces";

/**
 * The most bytes of attached files a workspace may keep, from `ATTACHMENT_QUOTA_MB`, or
 * undefined when the deployment sets no quota. A blank value sets none: `Number` reads it as 0.
 */
export function fileQuota(): number | undefined {
	const value = env.ATTACHMENT_QUOTA_MB?.trim();
	const megabytes = Number(value);
	if (!value || !Number.isFinite(megabytes) || megabytes < 0) return undefined;
	return Math.floor(megabytes * 1024 * 1024);
}

// Workspaces whose count this isolate has dropped while there is no quota. Uploads are not
// counted then, so a count kept from an earlier quota would fall behind what the bucket holds;
// dropped, it starts from the bucket again under the next quota. Once per isolate is enough,
// as the quota only changes with a new deployment, which starts new isolates.
const forgotten = new Set<string>();
const MAX_FORGOTTEN = 10_000;

/**
 * Takes `bytes` of a workspace's quota before a file is stored, and says whether it fit. Without
 * a quota, everything fits and nothing is counted, and any count is dropped. The workspace's
 * object keeps the count; when it has none, it starts from what the bucket holds for the
 * workspace.
 */
export async function reserveFileStorage(
	bucket: R2Bucket,
	workspaceId: string,
	bytes: number,
): Promise<boolean> {
	const limit = fileQuota();
	const stub = await findWorkspaceStub(db, workspaceId);
	if (limit === undefined) {
		if (!forgotten.has(workspaceId)) {
			// Without a quota an upload never depended on the object, so a failure here must not
			// refuse it: the count is dropped on a later upload instead.
			try {
				await stub.forgetFileStorage();
				if (forgotten.size >= MAX_FORGOTTEN) forgotten.clear();
				forgotten.add(workspaceId);
			} catch (error) {
				console.warn("files: could not drop the workspace's stored-bytes count", error);
			}
		}
		return true;
	}
	let reservation = await stub.reserveFileStorage({ bytes, limit });
	if ("needsSeed" in reservation) {
		const seed = await storedBytes(bucket, workspaceId);
		reservation = await stub.reserveFileStorage({ bytes, limit, seed });
	}
	return "ok" in reservation && reservation.ok;
}

/** Gives back what `reserveFileStorage` took for a file that was not stored after all. */
export async function releaseFileStorage(workspaceId: string, bytes: number): Promise<void> {
	if (fileQuota() === undefined || bytes <= 0) return;
	await (await findWorkspaceStub(db, workspaceId)).releaseFileStorage(bytes);
}

async function storedBytes(bucket: R2Bucket, workspaceId: string): Promise<number> {
	let total = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: `${workspaceId}/`, cursor, limit: 1000 });
		for (const object of page.objects) total += object.size;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return total;
}
