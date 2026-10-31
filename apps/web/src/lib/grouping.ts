import type {
	GroupBy,
	Issue,
	IssuePriority,
	IssueStatus,
	Member,
	OrderBy,
	Project,
} from "@gateweave/track-protocol";
import { PRIORITY_ORDER } from "#/components/issues/meta";
import { BOARD_STATUS_ORDER, groupByStatus, LIST_STATUS_ORDER, planPlacement } from "./issues";
import type { IssuePatch } from "./mutations";
import { type SortLookups, sortIssues, type TableSort } from "./table";

// Grouping and order for the list and the board (`IssueDisplay` in the protocol).

type GroupHead =
	| { by: "status"; value: IssueStatus }
	| { by: "priority"; value: IssuePriority }
	| { by: "assignee"; value: string | null }
	| { by: "project"; value: string | null }
	| { by: "none"; value: null };

/** Issues that share a value of the grouped field, in the display order. */
export type IssueGroup = GroupHead & {
	/** Names the group across renders and in drag and drop. */
	key: string;
	issues: Issue[];
};

/** What a group sets on an issue moved into it, and on an issue made there. */
export type GroupFields = Partial<
	Pick<IssuePatch, "status" | "priority" | "assigneeId" | "projectId">
>;

export function groupFields(group: GroupHead): GroupFields {
	switch (group.by) {
		case "status":
			return { status: group.value };
		case "priority":
			return { priority: group.value };
		case "assignee":
			return { assigneeId: group.value };
		case "project":
			return { projectId: group.value };
		case "none":
			return {};
	}
}

/** What names the groups of people and projects. */
export interface GroupLookups {
	members: ReadonlyMap<string, Pick<Member, "name">>;
	projects: ReadonlyMap<string, Pick<Project, "name">>;
}

const NO_LOOKUPS: SortLookups = {
	teams: new Map(),
	members: new Map(),
	projects: new Map(),
	cycles: new Map(),
};

/** Each order as a sort: priority runs urgent first, due dates soonest first, times newest first. */
const ORDER_SORTS: Record<Exclude<OrderBy, "manual">, TableSort> = {
	priority: { column: "priority", direction: "asc" },
	dueDate: { column: "dueDate", direction: "asc" },
	updated: { column: "updated", direction: "desc" },
	created: { column: "created", direction: "desc" },
};

/** Issues in an order, ties and empty values in manual order. Returns a new array. */
export function orderIssues(issues: readonly Issue[], orderBy: OrderBy): Issue[] {
	return sortIssues(issues, orderBy === "manual" ? null : ORDER_SORTS[orderBy], NO_LOOKUPS);
}

const keyOf = (by: GroupBy, value: string | number | null) => `${by}:${value ?? "none"}`;

/** People or projects with issues by name, then the issues without one. */
function byName(
	issues: readonly Issue[],
	idOf: (issue: Issue) => string | null,
	names: ReadonlyMap<string, { name: string }>,
	alwaysNone: boolean,
): { value: string | null; issues: Issue[] }[] {
	const buckets = new Map<string | null, Issue[]>();
	for (const issue of issues) {
		const id = idOf(issue);
		const bucket = buckets.get(id);
		if (bucket) bucket.push(issue);
		else buckets.set(id, [issue]);
	}
	if (alwaysNone && !buckets.has(null)) buckets.set(null, []);
	const name = (id: string) => names.get(id)?.name ?? id;
	const ids = [...buckets.keys()]
		.filter((id): id is string => id !== null)
		.sort((a, b) =>
			name(a).localeCompare(name(b), undefined, { sensitivity: "base", numeric: true }),
		);
	return [...ids, ...(buckets.has(null) ? [null] : [])].map((value) => ({
		value,
		issues: buckets.get(value) ?? [],
	}));
}

/**
 * Groups issues by a field and orders each group. Status and priority get a group for every
 * value, even an empty one, so that issues can be dropped into it; people and projects get one
 * for each that has issues, and a board also one for none. On a board, statuses run in workflow
 * order, in a list with work in flight first.
 */
export function groupIssues(
	issues: readonly Issue[],
	groupBy: GroupBy,
	orderBy: OrderBy,
	layout: "list" | "board",
	lookups: GroupLookups,
): IssueGroup[] {
	const groups = bucket(issues, groupBy, layout, lookups);
	for (const group of groups) {
		// Manual order is the sort already applied to each status group, but not to the rest.
		if (orderBy !== "manual" || group.by !== "status")
			group.issues = orderIssues(group.issues, orderBy);
	}
	return groups;
}

function bucket(
	issues: readonly Issue[],
	groupBy: GroupBy,
	layout: "list" | "board",
	lookups: GroupLookups,
): IssueGroup[] {
	switch (groupBy) {
		case "status":
			return groupByStatus(issues, layout === "board" ? BOARD_STATUS_ORDER : LIST_STATUS_ORDER).map(
				(group) => ({
					by: "status",
					value: group.status,
					key: keyOf("status", group.status),
					issues: group.issues,
				}),
			);
		case "priority": {
			const buckets = new Map<IssuePriority, Issue[]>(
				PRIORITY_ORDER.map((priority) => [priority, []]),
			);
			for (const issue of issues) buckets.get(issue.priority)?.push(issue);
			return PRIORITY_ORDER.map((priority) => ({
				by: "priority",
				value: priority,
				key: keyOf("priority", priority),
				issues: buckets.get(priority) ?? [],
			}));
		}
		case "assignee":
			return byName(issues, (issue) => issue.assigneeId, lookups.members, layout === "board").map(
				({ value, issues }) => ({ by: "assignee", value, key: keyOf("assignee", value), issues }),
			);
		case "project":
			return byName(issues, (issue) => issue.projectId, lookups.projects, layout === "board").map(
				({ value, issues }) => ({ by: "project", value, key: keyOf("project", value), issues }),
			);
		case "none":
			return [{ by: "none", value: null, key: keyOf("none", null), issues: [...issues] }];
	}
}

/**
 * What changes when `issue` is dropped at `index` among a group's issues (which may include it,
 * and count the others). Moving into another group sets the grouped field. Only in manual order
 * does the position count: it reorders within the group and places the issue in another; in any
 * other order the issue lands where the order puts it, so only the field changes. Returns null
 * when nothing would change.
 */
export function planGroupMove(
	group: IssueGroup,
	issue: Issue,
	index: number,
	manual: boolean,
): (GroupFields & { sortOrder?: string }) | null {
	const there = group.issues.some((other) => other.id === issue.id);
	const fields = there ? {} : groupFields(group);
	if (!manual) return Object.keys(fields).length > 0 ? fields : null;
	return planPlacement(group.issues, issue, index, fields);
}
