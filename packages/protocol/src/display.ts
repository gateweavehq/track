import { z } from "zod";

/** What a list or a board groups issues by. */
export const GROUP_BYS = ["status", "priority", "assignee", "project", "none"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

/**
 * What orders the issues of a list or a board (within each group). Priority runs from urgent to
 * none, due date from the soonest, and updated and created from the newest.
 */
export const ORDER_BYS = ["manual", "priority", "dueDate", "updated", "created"] as const;
export type OrderBy = (typeof ORDER_BYS)[number];

/** The properties a row of the list or a card of the board can show. */
export const ISSUE_PROPERTIES = [
	"id",
	"status",
	"priority",
	"assignee",
	"labels",
	"subIssues",
	"dueDate",
	"estimate",
	"created",
] as const;
export type IssueProperty = (typeof ISSUE_PROPERTIES)[number];

/** The columns of the issue table, in the order they appear. */
export const TABLE_COLUMNS = [
	"id",
	"title",
	"status",
	"priority",
	"assignee",
	"project",
	"cycle",
	"labels",
	"estimate",
	"startDate",
	"dueDate",
	"created",
	"updated",
] as const;
export type TableColumn = (typeof TABLE_COLUMNS)[number];

/** The columns that are always shown: they are what makes a row an issue. */
export const FIXED_COLUMNS = ["id", "title"] as const satisfies readonly TableColumn[];

/** Labels have no natural order, so that column is not sortable. */
export const SORT_COLUMNS = [
	"id",
	"title",
	"status",
	"priority",
	"assignee",
	"project",
	"cycle",
	"estimate",
	"startDate",
	"dueDate",
	"created",
	"updated",
] as const satisfies readonly TableColumn[];
export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";

/**
 * How a page of issues shows its issues, apart from which ones: grouping and order for the list
 * and the board, the properties on their rows and cards, and the table's columns and sort. A
 * property left out is the default (grouped by status, in manual order, every property and column
 * shown, the table unsorted), so `{}` and null mean the same.
 */
export const issueDisplay = z.object({
	groupBy: z.enum(GROUP_BYS).optional(),
	orderBy: z.enum(ORDER_BYS).optional(),
	properties: z.array(z.enum(ISSUE_PROPERTIES)).max(ISSUE_PROPERTIES.length).optional(),
	columns: z.array(z.enum(TABLE_COLUMNS)).max(TABLE_COLUMNS.length).optional(),
	sort: z.object({ column: z.enum(SORT_COLUMNS), direction: z.enum(["asc", "desc"]) }).optional(),
});
export type IssueDisplay = z.infer<typeof issueDisplay>;

/** Keeps the values of `all` that `values` holds, in the order of `all`. */
function inOrder<T extends string>(all: readonly T[], values: readonly T[]): T[] {
	const wanted = new Set<string>(values);
	return all.filter((value) => wanted.has(value));
}

/**
 * The same options without what is the default, with lists in a fixed order, so that equal
 * options look equal and a view that was never changed keeps no display at all.
 */
export function compactDisplay(display: IssueDisplay | null | undefined): IssueDisplay {
	const compact: IssueDisplay = {};
	if (!display) return compact;
	if (display.groupBy && display.groupBy !== "status") compact.groupBy = display.groupBy;
	if (display.orderBy && display.orderBy !== "manual") compact.orderBy = display.orderBy;
	if (display.properties) {
		const properties = inOrder(ISSUE_PROPERTIES, display.properties);
		if (properties.length < ISSUE_PROPERTIES.length) compact.properties = properties;
	}
	if (display.columns) {
		const columns = inOrder(TABLE_COLUMNS, [...display.columns, ...FIXED_COLUMNS]);
		if (columns.length < TABLE_COLUMNS.length) compact.columns = columns;
	}
	if (display.sort) {
		compact.sort = { column: display.sort.column, direction: display.sort.direction };
	}
	return compact;
}

/** What is stored for options: null when they are all the defaults. */
export function displayToStore(display: IssueDisplay | null | undefined): IssueDisplay | null {
	const compact = compactDisplay(display);
	return Object.keys(compact).length > 0 ? compact : null;
}

/** Whether two sets of options show issues the same way. */
export function sameDisplay(
	a: IssueDisplay | null | undefined,
	b: IssueDisplay | null | undefined,
): boolean {
	return JSON.stringify(compactDisplay(a)) === JSON.stringify(compactDisplay(b));
}
