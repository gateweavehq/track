import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { newBrowserContext } from "../e2e/fixtures";
import { syncBadge, waitForHydration } from "../e2e/helpers";
import { PASSWORD, PEOPLE } from "../scripts/seed-data";
// The one app module the tests import: it has no imports of its own.
import { MARK_ISSUE_LIST_SHOWN } from "../src/lib/timing";
import { BUDGETS, ISSUES, RUNS } from "./budgets";

const SLUG = "load";
const PORT = Number(process.env.TRACK_E2E_PORT) || 4711;
// In the config's output folder, so CI keeps it with the trace of a run over budget.
const STALLS_FILE = resolve(import.meta.dirname, "../test-results-perf/machine-stalls.jsonl");
const RESULTS_FILE = resolve(import.meta.dirname, "../test-results-perf/perf-results.jsonl");

// One worker (see the config) times the runs one at a time, so nothing else competes for the CPU.

interface Result {
	name: string;
	budgetMs: number;
	runsMs: number[];
	/** Edit propagation only: writer socket send to reader socket frame, then frame to title rendered. */
	stageRunsMs?: { socketMs: number | null; renderMs: number | null }[];
	medianMs: number;
	note: string;
	since: number;
	until: number;
}
const results: Result[] = [];
let machineProbe: ChildProcess | undefined;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	return value ?? Number.NaN;
}

/**
 * What `machine-probe.mjs` noted during a measurement, which says if the machine itself stalled.
 * Read once the probe has ended: a stall that spans the end of a measurement is noted after it.
 */
function machineStalls({ since, until }: Result): string {
	if (!existsSync(STALLS_FILE)) return "no stalls";
	const stalls = readFileSync(STALLS_FILE, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; at: number; ms: number })
		.filter((stall) => stall.at >= since && stall.at - stall.ms <= until);
	if (stalls.length === 0) return "no stalls";
	const longest = (kind: string) =>
		Math.max(0, ...stalls.filter((stall) => stall.kind === kind).map((stall) => stall.ms));
	return `${stalls.length} stalls, woke up to ${longest("timer")} ms late, wrote to disk in up to ${longest("disk")} ms`;
}

function record(result: Omit<Result, "medianMs" | "until">): Result {
	const full = { ...result, medianMs: median(result.runsMs), until: Date.now() };
	results.push(full);
	appendFileSync(RESULTS_FILE, `${JSON.stringify(full)}\n`);
	return full;
}

function stageRuns(result: Result): string {
	if (!result.stageRunsMs) return "—";
	return result.stageRunsMs
		.map(({ socketMs, renderMs }) =>
			socketMs === null || renderMs === null
				? "unavailable"
				: `${Math.round(socketMs)}+${Math.round(renderMs)}`,
		)
		.join(", ");
}

interface IssueFrame {
	at: number;
	titles: string[];
}

interface FrameWaiter {
	sent: boolean;
	title: string;
	resolve(at: number): void;
}

interface FrameLog {
	sent: IssueFrame[];
	received: IssueFrame[];
	waiters: FrameWaiter[];
}

function issueTitlesIn(text: string): string[] {
	if (
		(!text.includes('"delta"') && !text.includes('"mutate"')) ||
		!text.includes("issue") ||
		!text.includes('"title"')
	) {
		return [];
	}
	try {
		const message = JSON.parse(text) as { type?: unknown; ops?: unknown; mutation?: unknown };
		if (message.type === "mutate") {
			const mutation = message.mutation as
				| { name?: unknown; args?: { patch?: { title?: unknown } } }
				| undefined;
			const title = mutation?.args?.patch?.title;
			return mutation?.name === "issue.update" && typeof title === "string" ? [title] : [];
		}
		if (message.type !== "delta" || !Array.isArray(message.ops)) return [];
		const titles: string[] = [];
		for (const raw of message.ops) {
			if (typeof raw !== "object" || raw === null) continue;
			const op = raw as { entity?: unknown; op?: unknown; data?: unknown };
			if (op.entity !== "issue" || op.op !== "put") continue;
			const title = (op.data as { title?: unknown } | null)?.title;
			if (typeof title === "string") titles.push(title);
		}
		return titles;
	} catch {
		return [];
	}
}

function watchSocketFrames(page: Page): FrameLog {
	const log: FrameLog = { sent: [], received: [], waiters: [] };
	const recordFrame = (sent: boolean, payload: unknown) => {
		if (typeof payload !== "string") return;
		const titles = issueTitlesIn(payload);
		if (!titles.length) return;
		const at = Date.now();
		(sent ? log.sent : log.received).push({ at, titles });
		for (const waiter of [...log.waiters]) {
			if (waiter.sent !== sent || !titles.includes(waiter.title)) continue;
			log.waiters.splice(log.waiters.indexOf(waiter), 1);
			waiter.resolve(at);
		}
	};
	page.on("websocket", (socket) => {
		socket.on("framesent", (frame) => recordFrame(true, frame.payload));
		socket.on("framereceived", (frame) => recordFrame(false, frame.payload));
	});
	return log;
}

function waitForIssueFrame(log: FrameLog, title: string, sent: boolean): Promise<number> {
	const frames = sent ? log.sent : log.received;
	const existing = frames.find((entry) => entry.titles.includes(title));
	if (existing) return Promise.resolve(existing.at);
	return new Promise((resolve) => log.waiters.push({ sent, title, resolve }));
}

/** Signs in as one of the seeded people and opens the large workspace. */
async function openAs(browser: Browser, person: keyof typeof PEOPLE, timeIssueDeltas = false) {
	const context = await newBrowserContext(browser);
	const page = await context.newPage();
	const socketFrames = timeIssueDeltas ? watchSocketFrames(page) : undefined;
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByLabel("Email").fill(PEOPLE[person].email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await page.goto(`/${SLUG}`);
	await listShown(page);
	await expect(syncBadge(page)).toHaveText("Live");
	return { context, page, socketFrames };
}

/** Waits for the issue list and returns the mark's time since navigation start, and the rows. */
async function listShown(page: Page): Promise<{ startTime: number; count: number }> {
	const handle = await page.waitForFunction((name) => {
		const [mark] = performance.getEntriesByName(name);
		if (!mark) return null;
		const detail = (mark as PerformanceMark).detail as { count: number };
		return { startTime: mark.startTime, count: detail.count };
	}, MARK_ISSUE_LIST_SHOWN);
	return (await handle.jsonValue()) as { startTime: number; count: number };
}

test.beforeAll(async () => {
	test.setTimeout(300_000);
	// The seed script goes through the same doors as the app: sign-up over HTTP, then mutations
	// through the sync gateway. It signs up four people and fills the workspace.
	const seeded = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"scripts/seed.ts",
			...["--url", `http://localhost:${PORT}`, "--slug", SLUG, "--issues", String(ISSUES)],
		],
		{ cwd: resolve(import.meta.dirname, ".."), stdio: "inherit" },
	);
	if (seeded.status !== 0) throw new Error(`Seeding failed (exit ${seeded.status})`);

	mkdirSync(dirname(STALLS_FILE), { recursive: true });
	machineProbe = spawn(
		process.execPath,
		[resolve(import.meta.dirname, "machine-probe.mjs"), STALLS_FILE],
		{ stdio: ["pipe", "ignore", "inherit"] },
	);
});

test.afterAll(async () => {
	if (machineProbe) {
		// If it has already failed, no exit is still to come, and the numbers must print regardless.
		const running = machineProbe.exitCode === null && machineProbe.signalCode === null;
		const ended = running ? once(machineProbe, "exit") : undefined;
		machineProbe.stdin?.end();
		await ended;
	}
	const lines = results.map(
		(r) =>
			`${r.medianMs <= r.budgetMs ? "ok  " : "OVER"} ${r.name}: median ${Math.round(r.medianMs)} ms ` +
			`(budget ${r.budgetMs} ms; runs ${r.runsMs.map(Math.round).join(", ")}; stages ${stageRuns(r)}; ${r.note}; machine: ${machineStalls(r)})`,
	);
	console.log(`\nPerformance budgets\n${lines.join("\n")}\n`);

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (!summary || results.length === 0) return;
	const rows = results.map(
		(r) =>
			`| ${r.name} | ${Math.round(r.medianMs)} ms | ${r.budgetMs} ms | ${r.runsMs.map(Math.round).join(", ")} | ${stageRuns(r)} | ${machineStalls(r)} | ${r.medianMs <= r.budgetMs ? "ok" : "**over budget**"} |`,
	);
	appendFileSync(
		summary,
		[
			"## Performance budgets",
			"",
			"| Measurement | Median | Budget | Runs (ms) | Stages socket+render (ms) | Machine | |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			...rows,
			"",
		].join("\n"),
	);
});

test("opening a large workspace from the local copy stays within budget", async ({ browser }) => {
	test.setTimeout(180_000);
	const { context, page } = await openAs(browser, "maya");
	try {
		// The first open filled the replica and IndexedDB; wait until the sync has settled so a
		// reload really starts from the stored copy.
		await page.waitForTimeout(2000);

		// One reload to warm the HTTP cache and the service worker, not counted.
		await page.reload();
		await listShown(page);

		const since = Date.now();
		const times: number[] = [];
		let rows = 0;
		for (let run = 0; run < RUNS; run++) {
			await page.reload();
			const { startTime, count } = await listShown(page);
			times.push(startTime);
			rows = count;
		}
		const result = record({
			name: "Open a workspace from cache",
			budgetMs: BUDGETS.openFromCacheMs,
			runsMs: times,
			note: `${ISSUES}+ issues in the workspace, ${rows} in the list`,
			since,
		});
		expect(rows).toBeGreaterThan(100);
		expect(result.medianMs, "median open time").toBeLessThan(BUDGETS.openFromCacheMs);
	} finally {
		await context.close();
	}
});

test("an edit reaches another person within budget", async ({ browser }) => {
	test.setTimeout(180_000);
	const writer = await openAs(browser, "maya", true);
	const reader = await openAs(browser, "sam", true);
	try {
		// Both are on the same team: the first one the workspace opens.
		await expect(reader.page).toHaveURL(writer.page.url());

		// The list renders only the rows near the screen, so the edit is to an issue the reader can
		// see: a new issue may land in a group far down the list, outside the reader's view and so
		// not in the page at all. The row nearest the top of the reader's view, below the sticky
		// headers, is renamed; renaming keeps its place in the list.
		const key = await reader.page.evaluate(() => {
			for (const row of document.querySelectorAll("[data-checked]")) {
				const box = row.getBoundingClientRect();
				if (box.top < 120 || box.bottom > window.innerHeight) continue;
				const label = row.querySelector('[role="checkbox"]')?.getAttribute("aria-label");
				if (label?.startsWith("Select ")) return label.slice("Select ".length);
			}
			return null;
		});
		expect(key, "an issue in the reader's view").not.toBeNull();
		await writer.page.goto(`/${SLUG}/issue/${key}`);
		const titleField = writer.page.getByRole("textbox", { name: "Title" });
		await expect(titleField).toBeVisible();
		// The field shows from the local copy before this page's socket is up, and an edit made before
		// then waits for it, which would time the handshake instead of the edit.
		await expect(syncBadge(writer.page)).toHaveText("Live");

		const since = Date.now();
		const times: number[] = [];
		const stageTimes: { socketMs: number | null; renderMs: number | null }[] = [];
		let stagesUnavailable = 0;
		const nullOnError = async (promise: Promise<number>) => {
			try {
				return await promise;
			} catch {
				return null;
			}
		};
		const recordPropagation = (partial: boolean) =>
			record({
				name: "Edit reaches another person",
				budgetMs: BUDGETS.editPropagationMs,
				runsMs: times,
				stageRunsMs: stageTimes,
				note:
					"issue in the reader's view renamed, Enter to the new title in the other browser" +
					(stagesUnavailable
						? `; socket stage unavailable for ${stagesUnavailable} sample(s)`
						: "") +
					(partial ? "; incomplete samples published before the failure" : ""),
				since,
			});
		try {
			for (let run = 0; run < RUNS; run++) {
				const title = `Perf edit ${run} ${Math.random().toString(36).slice(2, 8)}`;
				const socketArrived = waitForIssueFrame(reader.socketFrames as FrameLog, title, false);
				const socketSent = waitForIssueFrame(writer.socketFrames as FrameLog, title, true);

				// In the reader: resolve with the clock the moment the title is in the page. Date.now()
				// is the same clock in both browsers, which run on this machine.
				const arrived = reader.page.evaluate(
					(needle) =>
						new Promise<number>((resolve) => {
							const check = () => document.body.textContent?.includes(needle) === true;
							if (check()) return resolve(Date.now());
							const observer = new MutationObserver(() => {
								if (!check()) return;
								observer.disconnect();
								resolve(Date.now());
							});
							observer.observe(document.body, {
								subtree: true,
								childList: true,
								characterData: true,
							});
						}),
					title,
				);

				await titleField.fill(title);
				// Stamp the Enter that saves the title from inside the page, so Playwright's own round
				// trip is not counted.
				await writer.page.evaluate(() => {
					document.addEventListener(
						"keydown",
						() => {
							(window as unknown as { __savedAt: number }).__savedAt = Date.now();
						},
						{ capture: true, once: true },
					);
				});
				await titleField.press("Enter");

				const arrivedAt = await arrived;
				// The frame is before the render in the page. If the frame listener cannot see it, keep
				// the end-to-end measurement and record the stage as unavailable; the assertions below fail.
				// The partial artifact still carries every completed sample.
				const socketAt = await Promise.race([
					nullOnError(socketArrived),
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
				]);
				const sentAt = await Promise.race([
					nullOnError(socketSent),
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
				]);
				const savedAt = await writer.page.evaluate(
					() => (window as unknown as { __savedAt: number }).__savedAt,
				);
				times.push(arrivedAt - savedAt);
				if (socketAt === null || sentAt === null) {
					stagesUnavailable++;
					stageTimes.push({ socketMs: null, renderMs: null });
				} else {
					stageTimes.push({ socketMs: socketAt - sentAt, renderMs: arrivedAt - socketAt });
				}
				// The row is still where the reader is looking.
				await expect(reader.page.getByRole("link", { name: title })).toBeInViewport();
			}
		} catch (error) {
			if (times.length) recordPropagation(true);
			throw error;
		}
		const result = recordPropagation(false);
		expect(
			result.stageRunsMs,
			"every completed sample records its propagation stages",
		).toHaveLength(RUNS);
		for (const [index, stages] of stageTimes.entries()) {
			expect(stages.socketMs, `sample ${index + 1} records its writer socket send`).toEqual(
				expect.any(Number),
			);
			expect(stages.renderMs, `sample ${index + 1} records its reader rendering time`).toEqual(
				expect.any(Number),
			);
		}
		expect(result.medianMs, "median propagation time").toBeLessThan(BUDGETS.editPropagationMs);
	} finally {
		await writer.context.close();
		await reader.context.close();
	}
});

test("a bulk change to every issue in a list stays within budget", async ({ browser }) => {
	test.setTimeout(240_000);
	const { context, page } = await openAs(browser, "maya");
	try {
		// A view of the whole workspace, so the list holds every issue, not one team's third. A view
		// is saved from a filtered list; then its filters, team included, come off.
		await page.getByRole("button", { name: "Filter", exact: true }).click();
		await page.getByRole("option", { name: "Priority" }).click();
		await page.getByRole("option", { name: "Urgent" }).click();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Save view" }).click();
		const save = page.getByRole("dialog", { name: /^Save/ });
		await save.getByLabel("Name").fill("Everything");
		await save.getByRole("button", { name: "Save view" }).click();
		await expect(page.getByRole("heading", { name: "Everything", level: 1 })).toBeVisible();
		await page.getByRole("button", { name: "Remove the priority filter" }).click();
		await page.getByRole("button", { name: "Remove the team filter" }).click();
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Unsaved changes")).toBeHidden();

		const bar = page.getByRole("region", { name: "Selected issues" });
		await page.locator("[data-checked] a").first().focus();
		await page.keyboard.press("ControlOrMeta+a");
		await expect(bar).toContainText("issues selected");
		// The bar counts the picks: the list renders only the rows near the screen.
		const picked = Number(/(\d+) issues selected/.exec((await bar.textContent()) ?? "")?.[1]);

		const since = Date.now();
		const times: number[] = [];
		const longest: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const priority = run % 2 === 0 ? "High" : "Low";
			// Long tasks while the change runs, and the click's time, both from inside the page.
			await page.evaluate(() => {
				const w = window as unknown as { __longest: number };
				w.__longest = 0;
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						w.__longest = Math.max(w.__longest, entry.duration);
					}
				}).observe({ type: "longtask" });
			});
			await bar.getByRole("button", { name: "Priority" }).click();
			// The click on the option is the one stamped: the menu's button was clicked first.
			await page.evaluate(() => {
				delete (window as unknown as { __clickedAt?: number }).__clickedAt;
				document.addEventListener(
					"click",
					() => {
						(window as unknown as { __clickedAt: number }).__clickedAt = performance.now();
					},
					{ capture: true, once: true },
				);
			});
			// Done, after the click, when every picked row in the page shows it. Those are the ones
			// near the screen; the rest are not rendered, and show it when scrolled to.
			const done = page.evaluate(
				(label) =>
					new Promise<number>((resolve) => {
						const check = () => {
							const rows = document.querySelectorAll('[data-checked="true"]');
							const shown = document.querySelectorAll(
								`[data-checked="true"] button[aria-label="${label}"]`,
							).length;
							const clicked = "__clickedAt" in window;
							if (clicked && rows.length > 0 && shown === rows.length) resolve(performance.now());
							else requestAnimationFrame(check);
						};
						requestAnimationFrame(check);
					}),
				`Priority: ${priority}`,
			);
			await page.getByRole("option", { name: priority }).click();
			const doneAt = await done;
			const clickedAt = await page.evaluate(
				() => (window as unknown as { __clickedAt: number }).__clickedAt,
			);
			times.push(doneAt - clickedAt);
			// Let the server's answers arrive before the long tasks are read and the next run.
			await expect(page.getByText(/unsynced/)).toBeHidden({ timeout: 60_000 });
			await page.waitForTimeout(500);
			longest.push(
				await page.evaluate(() => (window as unknown as { __longest: number }).__longest),
			);
		}
		const result = record({
			name: "Bulk change to a whole list",
			budgetMs: BUDGETS.bulkEditMs,
			runsMs: times,
			note: `${picked} issues picked, priority set from the bar`,
			since,
		});
		const blocked = record({
			name: "Longest task during a bulk change",
			budgetMs: BUDGETS.bulkEditLongestTaskMs,
			runsMs: longest,
			note: "from the click until the server has answered every change",
			since,
		});
		// Untimed: every picked issue has the last run's priority in the data, not only the rows on
		// screen. After a reload, from the replica the server's answers left, a filter by it counts
		// them all.
		const last = (RUNS - 1) % 2 === 0 ? "High" : "Low";
		await page.reload();
		await listShown(page);
		await expect(syncBadge(page)).toHaveText("Live");
		await page.getByRole("button", { name: "Filter", exact: true }).click();
		await page.getByRole("option", { name: "Priority" }).click();
		await page.getByRole("option", { name: last }).click();
		await page.keyboard.press("Escape");
		const counted = page.getByTitle(/^\d+ of \d+ issues$/);
		await expect(counted).toBeVisible();
		const withPriority = Number(/^(\d+) of/.exec((await counted.getAttribute("title")) ?? "")?.[1]);
		expect(withPriority, `issues with priority ${last}`).toBe(picked);
		// Every issue the seed made, and the sample ones besides.
		expect(picked).toBeGreaterThanOrEqual(ISSUES);
		expect(result.medianMs, "median bulk change time").toBeLessThan(BUDGETS.bulkEditMs);
		expect(blocked.medianMs, "median longest task").toBeLessThan(BUDGETS.bulkEditLongestTaskMs);
	} finally {
		await context.close();
	}
});
