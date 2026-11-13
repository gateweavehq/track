/**
 * The `wrangler r2 bucket create` arguments for a bucket binding. A bucket created with a
 * jurisdiction is a different bucket from one of the same name without it, so the jurisdiction
 * must go along, or the deploy would make an empty bucket next to the one the Worker uses.
 *
 * @param {{ bucket_name: string; jurisdiction?: string }} bucket The binding in wrangler.jsonc.
 * @returns {string[]}
 */
export function bucketCreateArgs(bucket) {
	const args = ["r2", "bucket", "create", bucket.bucket_name];
	return bucket.jurisdiction ? [...args, "--jurisdiction", bucket.jurisdiction] : args;
}

/**
 * What a failed `wrangler r2 bucket create` means for a deploy: the bucket is already there, R2
 * is off in the account, or the API token may not manage R2. A token made for Workers alone can
 * still deploy a Worker bound to a bucket that exists, and Cloudflare refuses the deploy if it
 * does not, so that case goes on without checking.
 *
 * @param {string} stderr What Wrangler printed.
 * @returns {"exists" | "r2-off" | "no-access" | "failed"}
 */
export function bucketCreateOutcome(stderr) {
	if (/already exists/.test(stderr)) return "exists";
	if (/enable R2|\[code: 10042\]/.test(stderr)) return "r2-off";
	if (/\[code: 10000\]/.test(stderr)) return "no-access";
	return "failed";
}
