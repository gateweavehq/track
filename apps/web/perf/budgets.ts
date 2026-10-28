// The performance budgets. Each is the most the median of several runs may take, in
// milliseconds; `pnpm test:perf` fails when a median goes over.
//
// How they were chosen: the median measured on a development laptop (Windows, Chromium, the
// production build) was about 700 ms to open and 13 ms to propagate. Opening got a budget near 3x
// that; propagation is so quick that the noise of a shared runner dominates it, so its budget is
// far looser in proportion, and only catches a change that makes it tens of times slower. CI runners have fewer and slower cores and
// are noisier than a laptop, so a budget this loose does not flake, while a real regression (the
// opening taking 3x as long) still fails. Tighten them when CI numbers, which every run writes to
// the job summary, show a lot of room. Do not loosen one to get a change through: find out what
// got slower.
export const BUDGETS = {
	/**
	 * Reload a workspace of 2,000+ issues whose copy is already in IndexedDB, from navigation
	 * start until its issue list is on screen (the `track:issue-list-shown` mark).
	 */
	openFromCacheMs: 2000,
	/**
	 * One person creates an issue; this is the time until another person's open list shows it,
	 * from the click to the row in the other browser.
	 */
	editPropagationMs: 200,
} as const;

/** How many times each measurement runs. The median of these is compared with the budget. */
export const RUNS = 5;

/** Issues in the workspace the measurements run against. */
export const ISSUES = 2000;
