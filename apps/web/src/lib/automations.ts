import {
	AUTOMATION_MONTH_MS,
	type Issue,
	isClosedCategory,
	type WorkflowStatus,
} from "@gateweave/track-protocol";

// What a team's automations would change, worked out on the local copy for the settings to show
// before they are saved. The workspace's server decides, by the same rules, in `automations.ts`.

/** The waits the settings offer, in months. */
export const AUTOMATION_CHOICES = [1, 3, 6, 12, 24];

/** The choices, with a wait set some other way (through the API, say) kept among them. */
export function automationChoices(current: number | null): number[] {
	if (current === null || AUTOMATION_CHOICES.includes(current)) return AUTOMATION_CHOICES;
	return [...AUTOMATION_CHOICES, current].sort((a, b) => a - b);
}

export function monthsLabel(months: number): string {
	return months === 1 ? "1 month" : `${months} months`;
}

/** Where closing puts issues: the team's first canceled status, if it has one. */
export function closeTarget(statuses: readonly WorkflowStatus[]): WorkflowStatus | undefined {
	return statuses.find((status) => status.category === "canceled");
}

/** The unarchived issues in these statuses that nobody touched for the months. */
function untouched(
	issues: readonly Issue[],
	keys: ReadonlySet<string>,
	months: number,
	now: number,
): Issue[] {
	const before = now - months * AUTOMATION_MONTH_MS;
	return issues.filter(
		(issue) => issue.archivedAt === null && keys.has(issue.status) && issue.updatedAt < before,
	);
}

/** The team's closed issues that archiving after the months would take now. */
export function dueToArchive(
	issues: readonly Issue[],
	statuses: readonly WorkflowStatus[],
	months: number,
	now = Date.now(),
): Issue[] {
	const closed = statuses.filter((status) => isClosedCategory(status.category));
	return untouched(issues, new Set(closed.map((status) => status.key)), months, now);
}

/** The team's issues nobody started that closing after the months would take now. */
export function dueToClose(
	issues: readonly Issue[],
	statuses: readonly WorkflowStatus[],
	months: number,
	now = Date.now(),
): Issue[] {
	if (!closeTarget(statuses)) return [];
	const waiting = statuses.filter(
		(status) => status.category === "backlog" || status.category === "unstarted",
	);
	return untouched(issues, new Set(waiting.map((status) => status.key)), months, now);
}
