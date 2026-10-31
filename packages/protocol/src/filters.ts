import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "./domain";

/** Due-date filters: overdue, due within a week (both for open issues only), or no due date. */
export const DUE_FILTERS = ["overdue", "week", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** Cycles named by where they stand: each issue's team's current cycle, or its next one. */
export const RELATIVE_CYCLES = ["current", "next"] as const;
export type RelativeCycle = (typeof RELATIVE_CYCLES)[number];

const id = z.string().min(1).max(64);

/**
 * Which issues a page of issues or a saved view shows. A property left out matches every issue;
 * one that is set matches issues with any of its values, and an issue must match every property
 * that is set. `null` among assignees, projects or cycles matches issues without one. Among
 * cycles, `current` and `next` stand for each issue's team's current and next cycle. Ids that no
 * longer resolve, such as a deleted label's, match nothing and are ignored when nothing else is
 * set.
 */
export const issueFilters = z.object({
	teamIds: z.array(id).min(1).max(50).optional(),
	statuses: z.array(z.enum(ISSUE_STATUSES)).min(1).max(ISSUE_STATUSES.length).optional(),
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
