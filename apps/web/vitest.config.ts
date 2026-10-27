import { defineConfig } from "vitest/config";

// Unit tests for the app's pure logic. They run in Node without the Workers runtime, so this
// config deliberately leaves out the Cloudflare and TanStack Start plugins from vite.config.ts.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		include: ["src/**/*.test.ts"],
	},
});
