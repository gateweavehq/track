// Checks the local toolchain and setup, and says how to fix anything missing. Changes nothing.
// Run with `pnpm doctor`, or `node scripts/doctor.mjs` if pnpm itself is the problem.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const web = join(root, "apps", "web");
const failures = [];

function pass(message) {
	console.log(`  ok    ${message}`);
}

function warn(message, hint) {
	console.log(`  warn  ${message}\n        ${hint}`);
}

function fail(message, fix) {
	console.log(`  FAIL  ${message}\n        ${fix}`);
	failures.push(message);
}

console.log("Toolchain");

const wantedNode = readFileSync(join(root, ".node-version"), "utf8").trim();
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
	fail(`Node.js ${process.versions.node} is too old`, `Install Node.js ${wantedNode}.`);
} else if (String(nodeMajor) !== wantedNode) {
	warn(`Node.js ${process.versions.node}`, `CI uses Node.js ${wantedNode}; 22+ works.`);
} else {
	pass(`Node.js ${process.versions.node}`);
}

// Package scripts call pnpm through the system shell, so check it the same way.
const wantedPnpm = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
).packageManager.split("@")[1];
const pnpm = spawnSync("pnpm --version", { shell: true, encoding: "utf8" });
const pnpmVersion = pnpm.status === 0 ? pnpm.stdout.trim() : null;
if (!pnpmVersion) {
	fail(
		"pnpm cannot be run from a shell, which package scripts need",
		`Install pnpm ${wantedPnpm}: https://pnpm.io/installation`,
	);
} else if (pnpmVersion !== wantedPnpm) {
	fail(
		`pnpm ${pnpmVersion}`,
		`This repository uses pnpm ${wantedPnpm}: pnpm self-update ${wantedPnpm}`,
	);
} else {
	pass(`pnpm ${pnpmVersion}`);
}

console.log("\nProject");

if (existsSync(join(root, "node_modules", ".pnpm"))) pass("Dependencies installed");
else fail("Dependencies are not installed", "Run: pnpm install");

const devVars = join(web, ".dev.vars");
const hasSecret =
	existsSync(devVars) && /^BETTER_AUTH_SECRET=\S+/m.test(readFileSync(devVars, "utf8"));
if (hasSecret) pass("apps/web/.dev.vars has BETTER_AUTH_SECRET");
else fail("apps/web/.dev.vars is missing or has no BETTER_AUTH_SECRET", "Run: pnpm dev:setup");

const d1 = join(web, ".wrangler", "state", "v3", "d1");
const migrated =
	existsSync(d1) &&
	readdirSync(d1, { recursive: true }).some((file) => String(file).endsWith(".sqlite"));
if (migrated) pass("Local D1 database exists");
else fail("Local D1 database has not been created", "Run: pnpm dev:setup");

const portFree = await new Promise((resolve) => {
	const server = createServer()
		.once("error", () => resolve(false))
		.once("listening", () => server.close(() => resolve(true)))
		.listen(3000, "127.0.0.1");
});
if (portFree) pass("Port 3000 is free for pnpm dev");
else
	warn(
		"Port 3000 is in use",
		"If it is not a Tangent dev server, run on another port: pnpm --filter @tangent/web exec vite dev --port 3001",
	);

if (failures.length > 0) {
	console.log(`\n${failures.length} problem(s) found.`);
	process.exitCode = 1;
} else {
	console.log("\nAll set. Start the app with: pnpm dev");
}
