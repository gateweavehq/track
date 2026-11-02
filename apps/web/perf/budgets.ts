// The performance budgets. Each is the most the median of several runs may take, in
// milliseconds; `pnpm test:perf` fails when a median goes over.
//
// How they were chosen: on GitHub's runners the medians were 536 ms to open and 14 ms to
// propagate (a development laptop: about 650 ms and 15 ms). Opening gets a budget near 3x that,
// loose enough not to flake on a noisy runner and tight enough that opening taking 3x as long
// fails. Propagation is so quick that runner noise dominates it, so its budget is looser in
// proportion and catches a change that makes it several times slower. Every run writes its
// numbers to the job summary; tighten a budget when they show a lot of room. Never loosen one to
// get a change through: find out what got slower.
export const BUDGETS = {
	/**
	 * Reload a workspace of 2,000+ issues whose copy is already in IndexedDB, from navigation
	 * start until its issue list is on screen (the `track:issue-list-shown` mark).
	 */
	openFromCacheMs: 1500,
	/**
	 * One person creates an issue; this is the time until another person's open list shows it,
	 * from the click to the row in the other browser.
	 */
	editPropagationMs: 100,
	/**
	 * Every issue in the list (about 680) is picked with Ctrl/Cmd+A and given another priority from
	 * the bulk-edit bar; this is the time from the click until every picked row shows it. A
	 * development container measured about 380 ms; before changes were batched (TRK-72) it took
	 * 2 s, and the server's answers then froze the tab for 18 s or more.
	 */
	bulkEditMs: 1000,
	/**
	 * The page's longest task from that click until the server has answered every change. It is
	 * the frame that renders every changed row, about 370 ms in the same container.
	 */
	bulkEditLongestTaskMs: 1000,
} as const;

/** How many times each measurement runs. The median of these is compared with the budget. */
export const RUNS = 5;

/** Issues in the workspace the measurements run against. */
export const ISSUES = 2000;
