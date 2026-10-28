// One-time local setup: creates .dev.vars at the repository root (next to wrangler.jsonc) with a
// random auth secret, and applies D1 migrations to the local database. Safe to re-run.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const DEV_VARS = "../../.dev.vars";
// Where .dev.vars lived before wrangler.jsonc moved to the root.
const OLD_DEV_VARS = ".dev.vars";

if (existsSync(DEV_VARS)) {
	console.log(".dev.vars already exists, leaving it alone.");
} else if (existsSync(OLD_DEV_VARS)) {
	renameSync(OLD_DEV_VARS, DEV_VARS);
	console.log("Moved apps/web/.dev.vars to the repository root, next to wrangler.jsonc.");
} else {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync("../../.dev.vars.example", "utf8");
	writeFileSync(
		DEV_VARS,
		template.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`),
	);
	console.log("Created .dev.vars with a fresh BETTER_AUTH_SECRET.");
}

execSync("pnpm db:migrate:local", { stdio: "inherit" });
