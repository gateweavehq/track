import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Clear the results once for the whole invocation. A failed test can restart its worker, and a
// worker-scoped cleanup would delete the measurements that explain that failure.
export default function globalSetup() {
	rmSync(resolve(import.meta.dirname, "../test-results-perf/perf-results.jsonl"), { force: true });
}
