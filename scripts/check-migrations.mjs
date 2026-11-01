#!/usr/bin/env node
// Checks the Durable Object migrations and PROTOCOL_VERSION, which parallel branches both bump.
//
//   node scripts/check-migrations.mjs                   the working tree on its own
//   node scripts/check-migrations.mjs --base origin/main   also against the branch it merges into
//
// On its own, it checks what a hand-resolved merge most easily breaks: the journal's numbering,
// its `when` times (the migrator skips an entry no later than the last one a workspace applied,
// so an out-of-order one is silently never run), the snapshot chain Drizzle Kit generates from,
// and migrations.js. With a base, a branch that adds migrations must come after every migration
// the base has, and a branch that changes PROTOCOL_VERSION must go above the base's. See
// .claude/skills/schema-change/SKILL.md for how to renumber.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DRIZZLE = "packages/sync-server/drizzle";
const JOURNAL = `${DRIZZLE}/meta/_journal.json`;
const MESSAGES = "packages/protocol/src/messages.ts";
const NO_PARENT = "00000000-0000-0000-0000-000000000000";

const problems = [];
const fail = (message) => problems.push(message);

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex === -1 ? null : args[baseIndex + 1];
if (baseIndex !== -1 && !base) {
	console.error("Usage: node scripts/check-migrations.mjs [--base <git ref>]");
	process.exit(2);
}

const read = (path) => readFileSync(join(root, path), "utf8");
const pad = (idx) => String(idx).padStart(4, "0");

/** A file as it is at a git ref, or null when the ref does not have it. */
function readAt(ref, path) {
	try {
		return execFileSync("git", ["show", `${ref}:${path}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function protocolVersion(source, where) {
	const match = /export const PROTOCOL_VERSION = (\d+);/.exec(source ?? "");
	if (!match) throw new Error(`No PROTOCOL_VERSION in ${MESSAGES} at ${where}`);
	return Number(match[1]);
}

// The working tree.

const journal = JSON.parse(read(JOURNAL));
const entries = journal.entries;
let previousSnapshot = null;
for (const [position, entry] of entries.entries()) {
	const name = `${entry.tag} (journal entry ${position})`;
	if (entry.idx !== position) fail(`${name} has idx ${entry.idx}; entries number from 0 up.`);
	if (!entry.tag.startsWith(`${pad(position)}_`)) {
		fail(`${name} should start with ${pad(position)}_, its place in the journal.`);
	}
	const before = entries[position - 1];
	if (before && entry.when <= before.when) {
		fail(
			`${name} was generated (when ${entry.when}) no later than ${before.tag} (when ${before.when}). ` +
				"The migrator would skip it on every workspace that already ran the one before. Regenerate it.",
		);
	}
	if (!existsSync(join(root, DRIZZLE, `${entry.tag}.sql`)))
		fail(`${name} has no ${entry.tag}.sql.`);
	const snapshotPath = `${DRIZZLE}/meta/${pad(position)}_snapshot.json`;
	if (!existsSync(join(root, snapshotPath))) {
		fail(`${name} has no meta/${pad(position)}_snapshot.json.`);
		previousSnapshot = null;
		continue;
	}
	const snapshot = JSON.parse(read(snapshotPath));
	if (position === 0 && snapshot.prevId !== NO_PARENT) {
		fail(`meta/0000_snapshot.json should have no parent, but has ${snapshot.prevId}.`);
	}
	if (previousSnapshot && snapshot.prevId !== previousSnapshot.id) {
		fail(
			`meta/${pad(position)}_snapshot.json follows ${snapshot.prevId}, not the snapshot before it ` +
				`(${previousSnapshot.id}). Drizzle Kit would diff from the wrong schema; regenerate it.`,
		);
	}
	previousSnapshot = snapshot;
}

const tags = new Set(entries.map((entry) => entry.tag));
for (const file of readdirSync(join(root, DRIZZLE))) {
	if (file.endsWith(".sql") && !tags.has(file.slice(0, -4))) {
		fail(`${DRIZZLE}/${file} is not in the journal, so it never runs.`);
	}
}
const snapshots = readdirSync(join(root, DRIZZLE, "meta")).filter((file) =>
	file.endsWith("_snapshot.json"),
);
if (snapshots.length !== entries.length) {
	fail(`meta has ${snapshots.length} snapshots for ${entries.length} journal entries.`);
}

const bundle = read(`${DRIZZLE}/migrations.js`);
for (const entry of entries) {
	const key = `m${pad(entry.idx)}`;
	const imported = new RegExp(`import ${key} from ["']\\./${entry.tag}\\.sql["'];`).test(bundle);
	// Imported, then listed: formatted or as Drizzle Kit writes it, with or without a comma.
	const listed = (bundle.match(new RegExp(`\\b${key}\\b`, "g")) ?? []).length >= 2;
	if (!imported || !listed) {
		fail(`migrations.js does not load ${entry.tag} as ${key}; run db:generate to rebuild it.`);
	}
}

// Against the base.

if (base) {
	const baseJournal = readAt(base, JOURNAL);
	const mergeBase = execFileSync("git", ["merge-base", "HEAD", base], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const forkJournal = readAt(mergeBase, JOURNAL);
	const baseEntries = baseJournal ? JSON.parse(baseJournal).entries : [];
	const forkTags = new Set((forkJournal ? JSON.parse(forkJournal).entries : []).map((e) => e.tag));
	const added = entries.filter((entry) => !forkTags.has(entry.tag));
	if (added.length > 0) {
		for (const [position, entry] of baseEntries.entries()) {
			if (entries[position]?.tag !== entry.tag) {
				fail(
					`${base} has migration ${entry.tag}, which this branch does not have at that place, ` +
						`and this branch adds ${added.map((e) => e.tag).join(", ")}. ` +
						`Merge ${base} and renumber this branch's migrations after it.`,
				);
				break;
			}
		}
	}

	const version = protocolVersion(read(MESSAGES), "the working tree");
	const forkVersion = protocolVersion(readAt(mergeBase, MESSAGES), mergeBase);
	const baseVersion = protocolVersion(readAt(base, MESSAGES), base);
	if (version !== forkVersion && version <= baseVersion) {
		fail(
			`This branch changes PROTOCOL_VERSION (${forkVersion} to ${version}), but ${base} is at ` +
				`${baseVersion}. Merge ${base} and set it to ${baseVersion + 1}.`,
		);
	} else if (version < baseVersion) {
		fail(`PROTOCOL_VERSION is ${version}, below ${base}'s ${baseVersion}.`);
	}
}

if (problems.length > 0) {
	console.error(`Migrations and protocol version: ${problems.length} problem(s)\n`);
	for (const problem of problems) console.error(`- ${problem}`);
	process.exit(1);
}
console.log(
	`Migrations and protocol version are in order: ${entries.length} migrations` +
		(base ? `, checked against ${base}.` : "."),
);
