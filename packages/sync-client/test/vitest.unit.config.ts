import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"test/{react,store,transport,upgrade-idb-rules,review-rules,browser-pending-format}.test.{ts,tsx}",
		],
		setupFiles: ["./test/setup.ts"],
		testTimeout: 10_000,
	},
});
