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
	 * One person renames an issue that another person's open list shows on screen; this is the
	 * time from the Enter that saves it until the new title is in the other browser's page. The
	 * list renders only the rows near the screen, so the issue is one the reader is looking at.
	 */
	editPropagationMs: 100,
	/**
	 * Every issue in a view of the whole workspace (2,000+) is picked with Ctrl/Cmd+A and given
	 * another priority from the bulk-edit bar; this is the time from the click until every picked
	 * row on screen shows it. A development container measured about 90 ms, down from 1,200 ms
	 * before the list rendered only the rows near the screen (TRK-74). Before changes were batched
	 * (TRK-72), a third as many took 2 s, and the server's answers then froze the tab for 18 s or
	 * more.
	 */
	bulkEditMs: 300,
	/**
	 * The page's longest task from that click until the server has answered every change, about
	 * 60 ms there. It was 1,300 ms while the list drew all its rows, not only those near the
	 * screen, in the frame that rendered every changed row.
	 */
	bulkEditLongestTaskMs: 200,
} as const;

/** How many times each measurement runs. The median of these is compared with the budget. */
export const RUNS = 5;

/** Issues in the workspace the measurements run against. */
export const ISSUES = 2000;
