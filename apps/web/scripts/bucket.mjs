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
