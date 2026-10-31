import {
	compactDisplay,
	FIXED_COLUMNS,
	type GroupBy,
	ISSUE_PROPERTIES,
	type IssueDisplay,
	type IssueProperty,
	type OrderBy,
	SORT_COLUMNS,
	TABLE_COLUMNS,
	type TableColumn,
} from "@gateweave/track-protocol";

// Display options for pages of issues and saved views (`IssueDisplay` in the protocol): how the
// issues are grouped and ordered, which properties show on rows and cards, and the table's
// columns and sort. Like filters, they are applied in the browser, so changing them is instant.

/**
 * A change to display options, made from the options as they are when it applies, for the same
 * reason filters take one (see `FiltersUpdate`).
 */
export type DisplayUpdate = (display: IssueDisplay) => IssueDisplay;

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
	status: "Status",
	priority: "Priority",
	assignee: "Assignee",
	project: "Project",
	none: "No grouping",
};

export const ORDER_BY_LABELS: Record<OrderBy, string> = {
	manual: "Manual",
	priority: "Priority",
	dueDate: "Due date",
	updated: "Updated",
	created: "Created",
};

export const PROPERTY_LABELS: Record<IssueProperty, string> = {
	id: "ID",
	status: "Status",
	priority: "Priority",
	assignee: "Assignee",
	labels: "Labels",
	subIssues: "Sub-issues",
	dueDate: "Due date",
	estimate: "Estimate",
	created: "Created",
};

/** The properties a board's cards have no room for. */
export const LIST_ONLY_PROPERTIES: readonly IssueProperty[] = ["created"];

export const TABLE_COLUMN_LABELS: Record<TableColumn, string> = {
	id: "ID",
	title: "Title",
	status: "Status",
	priority: "Priority",
	assignee: "Assignee",
	project: "Project",
	cycle: "Cycle",
	labels: "Labels",
	estimate: "Estimate",
	startDate: "Start date",
	dueDate: "Due date",
	created: "Created",
	updated: "Updated",
};

/** The columns people can hide: ID and Title are what makes a row an issue. */
export const HIDEABLE_COLUMNS = TABLE_COLUMNS.filter(
	(column) => !(FIXED_COLUMNS as readonly TableColumn[]).includes(column),
);

export const groupByOf = (display: IssueDisplay): GroupBy => display.groupBy ?? "status";
export const orderByOf = (display: IssueDisplay): OrderBy => display.orderBy ?? "manual";

/** The properties rows and cards show: all of them unless the options pick some. */
export function shownProperties(display: IssueDisplay): ReadonlySet<IssueProperty> {
	return new Set(display.properties ?? ISSUE_PROPERTIES);
}

/** The table's columns, in their order. ID and Title are always among them. */
export function shownColumns(display: IssueDisplay): TableColumn[] {
	const wanted = new Set<TableColumn>([...(display.columns ?? TABLE_COLUMNS), ...FIXED_COLUMNS]);
	return TABLE_COLUMNS.filter((column) => wanted.has(column));
}

/** The options with one property shown or hidden. */
export function toggleProperty(display: IssueDisplay, property: IssueProperty): IssueDisplay {
	const shown = shownProperties(display);
	const next = ISSUE_PROPERTIES.filter((other) => (other === property) !== shown.has(other));
	return compactDisplay({ ...display, properties: next });
}

/** The options with one table column shown or hidden. */
export function toggleColumn(display: IssueDisplay, column: TableColumn): IssueDisplay {
	const shown = new Set(shownColumns(display));
	if (!shown.delete(column)) shown.add(column);
	return compactDisplay({ ...display, columns: [...shown] });
}

/** Whether any option differs from the defaults. */
export function hasDisplay(display: IssueDisplay): boolean {
	return Object.keys(compactDisplay(display)).length > 0;
}

/** A table sort as one URL value, such as `dueDate.desc`. */
export function sortToParam(sort: IssueDisplay["sort"]): string | undefined {
	return sort ? `${sort.column}.${sort.direction}` : undefined;
}

/** The sort a URL value names, or none if it is not one. */
export function sortFromParam(value: string | undefined): IssueDisplay["sort"] {
	const [column, direction, ...rest] = (value ?? "").split(".");
	const found = SORT_COLUMNS.find((candidate) => candidate === column);
	if (!found || rest.length > 0 || (direction !== "asc" && direction !== "desc")) return undefined;
	return { column: found, direction };
}
