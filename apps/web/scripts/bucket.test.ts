import { describe, expect, it } from "vitest";
import { bucketCreateOutcome } from "./bucket.mjs";

// What Wrangler printed in each case, as it reached the deploy script.
const failed = (message: string) =>
	`✘ [ERROR] A request to the Cloudflare API (/accounts/abc/r2/buckets) failed.\n\n  ${message}\n`;

describe("bucketCreateOutcome", () => {
	it("goes on when the bucket is there", () => {
		expect(
			bucketCreateOutcome(
				failed("The bucket you tried to create already exists, and you own it. [code: 10004]"),
			),
		).toBe("exists");
	});

	it("goes on unchecked when the token may not manage R2, as a production token for Workers", () => {
		expect(bucketCreateOutcome(failed("Authentication error [code: 10000]"))).toBe("no-access");
	});

	it("stops when R2 is off in the account", () => {
		expect(
			bucketCreateOutcome(
				failed("Please enable R2 through the Cloudflare Dashboard. [code: 10042]"),
			),
		).toBe("r2-off");
	});

	it("stops on anything else", () => {
		expect(bucketCreateOutcome("fetch failed")).toBe("failed");
		expect(bucketCreateOutcome(failed("Internal error [code: 10001]"))).toBe("failed");
	});
});
