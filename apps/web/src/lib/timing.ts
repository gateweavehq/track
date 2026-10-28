/**
 * User Timing marks for the numbers the performance budgets (`apps/web/perf`) measure. Marks
 * are cheap, show up in the browser's Performance panel, and cost nothing when nobody looks.
 */

/** Names of the marks the app records. The perf tests read them by these names. */
export const MARK_ISSUE_LIST_SHOWN = "track:issue-list-shown";

/**
 * Records that an issue list is on screen, once per page load: the first list a navigation
 * renders from the local replica. Its `startTime` is the time since navigation start, so on a
 * reload it is how long opening the workspace took.
 */
export function markIssueListShown(count: number): void {
	if (typeof performance === "undefined") return;
	if (performance.getEntriesByName(MARK_ISSUE_LIST_SHOWN).length > 0) return;
	// After the next frame, so the mark means painted rather than merely committed.
	requestAnimationFrame(() => {
		if (performance.getEntriesByName(MARK_ISSUE_LIST_SHOWN).length > 0) return;
		performance.mark(MARK_ISSUE_LIST_SHOWN, { detail: { count } });
	});
}
