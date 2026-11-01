import {
	compareStatuses,
	DEFAULT_STATUSES,
	type Issue,
	isClosedCategory,
	liveStatuses,
	type StatusCategory,
	statusId,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

// Each team has its own statuses (`WorkflowStatus` in the protocol). An issue's `status` is the
// key of one of its team's statuses; what Track does with it follows the status's category.

/** The workspace's statuses by id, removed ones included, as the replica holds them. */
export type StatusMap = ReadonlyMap<string, WorkflowStatus>;

/**
 * The status an issue is in, as its team has it. A key the copy does not have (a status added
 * elsewhere a moment ago) shows as the built-in status of that key, or as itself in the backlog,
 * until the status arrives.
 */
export function statusOf(
	statuses: StatusMap,
	issue: Pick<Issue, "teamId" | "status">,
): WorkflowStatus {
	return statuses.get(statusId(issue.teamId, issue.status)) ?? standIn(issue.teamId, issue.status);
}

function standIn(teamId: string, key: string): WorkflowStatus {
	const builtIn = DEFAULT_STATUSES.find((status) => status.key === key);
	return {
		id: statusId(teamId, key),
		teamId,
		key,
		name: builtIn?.name ?? key,
		category: builtIn?.category ?? "backlog",
		color: builtIn?.color ?? null,
		sortOrder: builtIn?.sortOrder ?? "a0",
		createdAt: 0,
		updatedAt: 0,
		removedAt: null,
	};
}

/** Whether an issue is closed: in a completed or canceled status. */
export function isIssueClosed(statuses: StatusMap, issue: Pick<Issue, "teamId" | "status">) {
	return isClosedCategory(statusOf(statuses, issue).category);
}

/** A team's statuses that issues can be in, in the team's order. */
export function teamStatuses(statuses: StatusMap, teamId: string): WorkflowStatus[] {
	return liveStatuses([...statuses.values()].filter((status) => status.teamId === teamId));
}

/** The first status of a category in a team, such as where "Close as duplicate" puts an issue. */
export function firstOfCategory(
	statuses: StatusMap,
	teamId: string,
	category: StatusCategory,
): WorkflowStatus | undefined {
	return teamStatuses(statuses, teamId).find((status) => status.category === category);
}

/** Categories in the order of a list's groups: work in flight first, finished work last. */
const LIST_CATEGORIES: readonly StatusCategory[] = [
	"started",
	"unstarted",
	"backlog",
	"completed",
	"canceled",
];

/** A list's order of statuses: by category in flight first, then each team's order. */
export function compareForList(a: WorkflowStatus, b: WorkflowStatus): number {
	const byCategory = LIST_CATEGORIES.indexOf(a.category) - LIST_CATEGORIES.indexOf(b.category);
	return byCategory !== 0 ? byCategory : compareStatuses(a, b);
}

/**
 * The statuses to group issues of some teams by, one per key: teams that share a key (every
 * team's built-in statuses, and statuses of the same name) share its group, named as the first
 * team in `teamIds` names it. On a board they run in workflow order, in a list with work in
 * flight first.
 */
export function statusColumns(
	statuses: StatusMap,
	teamIds: readonly string[],
	layout: "list" | "board",
): WorkflowStatus[] {
	const byKey = new Map<string, WorkflowStatus>();
	for (const teamId of teamIds) {
		for (const status of teamStatuses(statuses, teamId)) {
			if (!byKey.has(status.key)) byKey.set(status.key, status);
		}
	}
	return [...byKey.values()].sort(layout === "board" ? compareStatuses : compareForList);
}

/**
 * The teams whose statuses group a page of issues: the page's team, or else the teams of its
 * issues (all of them when there are none), in order of their keys.
 */
export function groupingTeams(
	issues: readonly Pick<Issue, "teamId">[],
	teams: ReadonlyMap<string, Pick<Team, "id" | "key">>,
	teamId: string | undefined,
): string[] {
	if (teamId !== undefined) return [teamId];
	const shown = new Set(issues.map((issue) => issue.teamId));
	const sorted = [...teams.values()].sort((a, b) => a.key.localeCompare(b.key));
	const withIssues = sorted.filter((team) => shown.has(team.id));
	return (withIssues.length > 0 ? withIssues : sorted).map((team) => team.id);
}

/** What teams call a status key, such as one a filter names: a live status's name first. */
export function statusName(statuses: StatusMap, key: string): string {
	let removed: string | undefined;
	for (const status of statuses.values()) {
		if (status.key !== key) continue;
		if (status.removedAt === null) return status.name;
		removed ??= status.name;
	}
	return removed ?? DEFAULT_STATUSES.find((status) => status.key === key)?.name ?? key;
}

/** The sort order that puts a status last in a category of a team's live statuses. */
export function sortOrderAtEnd(
	team: readonly WorkflowStatus[],
	category: StatusCategory,
	except?: string,
): string {
	const last = team
		.filter((status) => status.category === category && status.key !== except)
		.at(-1);
	return generateKeyBetween(last?.sortOrder ?? null, null);
}

export interface StatusOrder {
	key: string;
	sortOrder: string;
}

/**
 * The sort orders that move a status one place up (-1) or down (1) within its category: one for
 * the status, or one for each status of the category when its new neighbours share an order and
 * nothing fits between them. Empty when it is already first or last.
 */
export function moveStatus(
	team: readonly WorkflowStatus[],
	key: string,
	by: -1 | 1,
): StatusOrder[] {
	const status = team.find((item) => item.key === key);
	if (!status) return [];
	const peers = team.filter((item) => item.category === status.category);
	const from = peers.indexOf(status);
	const to = from + by;
	const other = peers[to];
	if (!other) return [];
	peers[to] = status;
	peers[from] = other;
	const before = peers[to - 1]?.sortOrder ?? null;
	const after = peers[to + 1]?.sortOrder ?? null;
	if (before === null || after === null || before < after) {
		return [{ key, sortOrder: generateKeyBetween(before, after) }];
	}
	const orders = generateNKeysBetween(null, null, peers.length);
	return peers.flatMap((item, index) => {
		const sortOrder = orders[index];
		return sortOrder === undefined || sortOrder === item.sortOrder
			? []
			: [{ key: item.key, sortOrder }];
	});
}

/**
 * Why a status cannot be removed, or null when it can: a team keeps a completed status, and
 * needs another status to move the issues to.
 */
export function cannotRemove(team: readonly WorkflowStatus[], key: string): string | null {
	const status = team.find((item) => item.key === key);
	if (!status) return "It is not one of the team's statuses.";
	const others = team.filter((item) => item.key !== key);
	if (others.length === 0) return "A team needs at least one status.";
	if (status.category === "completed" && !others.some((item) => item.category === "completed")) {
		return "A team needs at least one completed status.";
	}
	return null;
}

/** Where a removed status's issues go unless the admin picks: the next of its kind, or the first. */
export function defaultMoveTo(team: readonly WorkflowStatus[], key: string): string | undefined {
	const status = team.find((item) => item.key === key);
	const others = team.filter((item) => item.key !== key);
	return (others.find((item) => item.category === status?.category) ?? others[0])?.key;
}
