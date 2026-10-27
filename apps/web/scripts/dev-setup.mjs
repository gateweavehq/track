// One-time local setup: creates .dev.vars with a random auth secret and applies D1 migrations
// to the local database. Safe to re-run.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEV_VARS = ".dev.vars";

if (existsSync(DEV_VARS)) {
	console.log(`${DEV_VARS} already exists, leaving it alone.`);
} else {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync(".dev.vars.example", "utf8");
	writeFileSync(
		DEV_VARS,
		template.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`),
	);
	console.log(`Created ${DEV_VARS} with a fresh BETTER_AUTH_SECRET.`);
}

execSync("wrangler d1 migrations apply DB --local", { stdio: "inherit" });
