import { z } from "zod";
import { ISSUE_PRIORITIES } from "./domain";
import { STATUS_KEY_PATTERN } from "./statuses";

/** Due-date filters: overdue, due within a week (both for open issues only), or no due date. */
export const DUE_FILTERS = ["overdue", "week", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** Cycles named by where they stand: each issue's team's current cycle, or its next one. */
export const RELATIVE_CYCLES = ["current", "next"] as const;
export type RelativeCycle = (typeof RELATIVE_CYCLES)[number];

const id = z.string().min(1).max(64);
const statusKey = z.string().regex(STATUS_KEY_PATTERN);

/**
 * Which issues a page of issues or a saved view shows. A property left out matches every issue;
 * one that is set matches issues with any of its values, and an issue must match every property
 * that is set. `null` among assignees, projects or cycles matches issues without one. Among
 * cycles, `current` and `next` stand for each issue's team's current and next cycle. Statuses are
 * keys, so one matches the status of that key in every team. Ids and keys that no longer resolve,
 * such as a deleted label's, match nothing and are ignored when nothing else is set.
 */
export const issueFilters = z.object({
	teamIds: z.array(id).min(1).max(50).optional(),
	statuses: z.array(statusKey).min(1).max(100).optional(),
	priorities: z.array(z.literal(ISSUE_PRIORITIES)).min(1).max(ISSUE_PRIORITIES.length).optional(),
	assigneeIds: z.array(id.nullable()).min(1).max(100).optional(),
	projectIds: z.array(id.nullable()).min(1).max(100).optional(),
	cycles: z
		.array(z.union([z.enum(RELATIVE_CYCLES), id]).nullable())
		.min(1)
		.max(100)
		.optional(),
	labelIds: z.array(id).min(1).max(50).optional(),
	due: z.enum(DUE_FILTERS).optional(),
});
export type IssueFilters = z.infer<typeof issueFilters>;
export type IssueFilterKey = keyof IssueFilters;
