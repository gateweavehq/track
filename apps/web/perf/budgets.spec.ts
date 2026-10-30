import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { newBrowserContext } from "../e2e/fixtures";
import { syncBadge, waitForHydration } from "../e2e/helpers";
import { PASSWORD, PEOPLE } from "../scripts/seed-data";
// The one app module the tests import: it has no imports of its own.
import { MARK_ISSUE_LIST_SHOWN } from "../src/lib/timing";
import { BUDGETS, ISSUES, RUNS } from "./budgets";

const SLUG = "load";
const PORT = Number(process.env.TRACK_E2E_PORT) || 4711;

// One worker (see the config) times the runs one at a time, so nothing else competes for the CPU.

interface Result {
	name: string;
	budgetMs: number;
	runsMs: number[];
	medianMs: number;
	note: string;
}
const results: Result[] = [];

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const value =
		sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	return value ?? Number.NaN;
}

function record(result: Omit<Result, "medianMs">): Result {
	const full = { ...result, medianMs: median(result.runsMs) };
	results.push(full);
	return full;
}

/** Signs in as one of the seeded people and opens the large workspace. */
async function openAs(browser: Browser, person: keyof typeof PEOPLE) {
	const context = await newBrowserContext(browser);
	const page = await context.newPage();
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByLabel("Email").fill(PEOPLE[person].email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await page.goto(`/${SLUG}`);
	await listShown(page);
	await expect(syncBadge(page)).toHaveText("Live");
	return { context, page };
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
});

test.afterAll(() => {
	const lines = results.map(
		(r) =>
			`${r.medianMs <= r.budgetMs ? "ok  " : "OVER"} ${r.name}: median ${Math.round(r.medianMs)} ms ` +
			`(budget ${r.budgetMs} ms; runs ${r.runsMs.map(Math.round).join(", ")}; ${r.note})`,
	);
	console.log(`\nPerformance budgets\n${lines.join("\n")}\n`);

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (!summary || results.length === 0) return;
	const rows = results.map(
		(r) =>
			`| ${r.name} | ${Math.round(r.medianMs)} ms | ${r.budgetMs} ms | ${r.runsMs.map(Math.round).join(", ")} | ${r.medianMs <= r.budgetMs ? "ok" : "**over budget**"} |`,
	);
	appendFileSync(
		summary,
		[
			"## Performance budgets",
			"",
			"| Measurement | Median | Budget | Runs (ms) | |",
			"| --- | --- | --- | --- | --- |",
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
		});
		expect(rows).toBeGreaterThan(100);
		expect(result.medianMs, "median open time").toBeLessThan(BUDGETS.openFromCacheMs);
	} finally {
		await context.close();
	}
});

test("an edit reaches another person within budget", async ({ browser }) => {
	test.setTimeout(180_000);
	const writer = await openAs(browser, "maya");
	const reader = await openAs(browser, "sam");
	try {
		// Both are on the same team: the first one the workspace opens.
		await expect(reader.page).toHaveURL(writer.page.url());

		const times: number[] = [];
		for (let run = 0; run < RUNS; run++) {
			const title = `Perf edit ${run} ${Math.random().toString(36).slice(2, 8)}`;

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

			await writer.page.getByRole("button", { name: "New issue" }).first().click();
			const dialog = writer.page.getByRole("dialog", { name: "New issue" });
			await dialog.getByLabel("Title").fill(title);
			// Stamp the click from inside the page, so Playwright's own round trip is not counted.
			await writer.page.evaluate(() => {
				document.addEventListener(
					"click",
					() => {
						(window as unknown as { __clickedAt: number }).__clickedAt = Date.now();
					},
					{ capture: true, once: true },
				);
			});
			await dialog.getByRole("button", { name: "Create issue" }).click();

			const arrivedAt = await arrived;
			const clickedAt = await writer.page.evaluate(
				() => (window as unknown as { __clickedAt: number }).__clickedAt,
			);
			times.push(arrivedAt - clickedAt);
			await expect(dialog).toBeHidden();
		}
		const result = record({
			name: "Edit reaches another person",
			budgetMs: BUDGETS.editPropagationMs,
			runsMs: times,
			note: "new issue, click to row visible in the other browser",
		});
		expect(result.medianMs, "median propagation time").toBeLessThan(BUDGETS.editPropagationMs);
	} finally {
		await writer.context.close();
		await reader.context.close();
	}
});
