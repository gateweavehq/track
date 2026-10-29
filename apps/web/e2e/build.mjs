// Builds the app for the end-to-end tests. It is the normal build, plus TRACK_E2E, which makes
// vite.config.ts pin the address the tests use as BETTER_AUTH_URL. That turns /mcp on, so a test
// can play an agent. (Run through Node so the variable is set the same way on every platform.)
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const built = spawnSync(
	process.execPath,
	[resolve(root, "node_modules/vite/bin/vite.js"), "build"],
	{
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, TRACK_E2E: "1" },
	},
);
process.exit(built.status ?? 1);
