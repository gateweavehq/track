import { env } from "cloudflare:workers";
import { workspaceStub } from "./workspaces";

/**
 * The most bytes of attached files a workspace may keep, from `ATTACHMENT_QUOTA_MB`, or
 * undefined when the deployment sets no quota.
 */
export function fileQuota(): number | undefined {
	const megabytes = Number(env.ATTACHMENT_QUOTA_MB);
	if (!env.ATTACHMENT_QUOTA_MB || !Number.isFinite(megabytes) || megabytes < 0) return undefined;
	return Math.floor(megabytes * 1024 * 1024);
}

/**
 * Takes `bytes` of a workspace's quota before a file is stored, and says whether it fit. Without
 * a quota, everything fits and nothing is counted. The workspace's object keeps the count; the
 * first time it is needed, it starts from what the bucket already holds for the workspace.
 */
export async function reserveFileStorage(
	bucket: R2Bucket,
	workspaceId: string,
	bytes: number,
): Promise<boolean> {
	const limit = fileQuota();
	if (limit === undefined) return true;
	const stub = workspaceStub(workspaceId);
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
	await workspaceStub(workspaceId).releaseFileStorage(bytes);
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
