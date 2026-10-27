import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Starts the test worker that hosts WorkspaceDO, so clients sync against the real thing.
		globalSetup: ["./test/global-setup.ts"],
		setupFiles: ["./test/setup.ts"],
		testTimeout: 20_000,
	},
});
