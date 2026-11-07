// A control for the performance budgets. This process shares nothing with the app but the machine:
// it wakes every 10 ms and syncs a small write to disk every 100 ms, and notes when either takes
// far longer than it should. A run over budget with stalls here points at the machine; one without
// them points at the app. Each stall is a line of JSON in the file named by the argument.
import { appendFile, open, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const STALL_MS = 50;
const WAKE_MS = 10;
const WRITE_EVERY_MS = 100;

const [, , stallsFile] = process.argv;
if (!stallsFile) throw new Error("Name the file to note stalls in");

// In order, and all done before this process ends, so the test can read them once it has ended.
let notes = Promise.resolve();
function note(kind, ms) {
	const line = `${JSON.stringify({ kind, at: Date.now(), ms: Math.round(ms) })}\n`;
	notes = notes.then(() => appendFile(stallsFile, line));
}

let woke = performance.now();
setInterval(() => {
	const now = performance.now();
	const late = now - woke - WAKE_MS;
	woke = now;
	if (late > STALL_MS) note("timer", late);
}, WAKE_MS);

const scratch = `${stallsFile}.write`;
const file = await open(scratch, "w");
const block = Buffer.alloc(4096);
let writing = null;
const writes = setInterval(() => {
	// One write at a time: a slow one is what is being looked for, so they must not pile up.
	if (writing) return;
	const started = performance.now();
	writing = file
		.write(block, 0, block.length, 0)
		.then(() => file.sync())
		.then(() => {
			const took = performance.now() - started;
			writing = null;
			if (took > STALL_MS) note("disk", took);
		});
}, WRITE_EVERY_MS);

// The pipe from the test's process closes when the test asks or when that process ends, however it
// ends. A write under way may still be slow, so it finishes and is noted before the notes are.
process.stdin.resume();
process.stdin.on("close", async () => {
	clearInterval(writes);
	await writing;
	await notes;
	await file.close();
	await rm(scratch, { force: true });
	process.exit(0);
});
