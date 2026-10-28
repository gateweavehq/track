import { defineConfig, devices } from "@playwright/test";

// Performance budgets: `pnpm test:perf`. Kept apart from the end-to-end tests (`playwright.config.ts`)
// because they time things, so they run one at a time on a quiet machine, and a slow run is a
// failure rather than a flake. They use the same server as the e2e tests, the production build on
// port 4711 with its own empty local database; the spec fills a workspace with 2,000 issues.
const PORT = 4711;

export default defineConfig({
	testDir: "perf",
	timeout: 180_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	outputDir: "test-results-perf",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "node e2e/server.mjs",
		url: `http://localhost:${PORT}/login`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
