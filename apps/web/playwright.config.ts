import { defineConfig, devices } from "@playwright/test";

// Port 4711 keeps clear of `pnpm dev` (4710). The tests run against the production build, since
// the service worker that lets Track start offline exists only there. TRACK_E2E_PORT moves them,
// so two checkouts can run them at once; set it for the build (e2e/build.mjs) too.
const PORT = Number(process.env.TRACK_E2E_PORT) || 4711;

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// Tests share one server but never data: every test signs up its own user and workspace.
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
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
		stdout: "pipe",
		stderr: "pipe",
	},
});
