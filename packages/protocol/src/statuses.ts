/**
 * Workflow statuses. Each team has its own, in an order its admins choose, and each status is in
 * one of five fixed categories. What Track does with an issue's status (whether it is closed,
 * counts as done in a cycle, or blocks another) follows the category, so a team's own statuses
 * work everywhere without Track knowing them.
 */

export const STATUS_CATEGORIES = [
	"backlog",
	"unstarted",
	"started",
	"completed",
	"canceled",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Categories of the statuses that close an issue. */
export const CLOSED_CATEGORIES: readonly StatusCategory[] = ["completed", "canceled"];

export function isClosedCategory(category: StatusCategory): boolean {
	return CLOSED_CATEGORIES.includes(category);
}

/** Statuses a team has at most, removed ones aside. */
export const MAX_STATUSES_PER_TEAM = 30;

/** A status's key: lowercase letters, digits and underscores, starting with a letter. */
export const STATUS_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * One of a team's statuses. An issue's `status` is the `key` of one of its team's statuses. The
 * key is made from the name when the status is created and never changes, so renaming a status
 * keeps what refers to it, and teams that add a status of the same name line up across teams.
 * A removed status keeps its row so history still names it, and its key is never used again in
 * the team.
 */
export interface WorkflowStatus {
	/** `${teamId}/${key}`: see {@link statusId}. */
	id: string;
	teamId: string;
	key: string;
	name: string;
	category: StatusCategory;
	/** `#rrggbb`, lowercase, or null for the neutral color of the theme. */
	color: string | null;
	/** Fractional index of the status within its category. */
	sortOrder: string;
	createdAt: number;
	updatedAt: number;
	/** When an admin removed it, moving its issues to another status. */
	removedAt: number | null;
}

/** The id of a team's status: mutations name a status by its team and key. */
export function statusId(teamId: string, key: string): string {
	return `${teamId}/${key}`;
}

/**
 * The statuses every team starts with. Their keys were Track's only statuses before teams had
 * their own, so issues, history and integrations from that time keep their meaning.
 */
export const DEFAULT_STATUSES = [
	{ key: "backlog", name: "Backlog", category: "backlog", color: null, sortOrder: "a0" },
	{ key: "todo", name: "Todo", category: "unstarted", color: null, sortOrder: "a0" },
	{
		key: "in_progress",
		name: "In Progress",
		category: "started",
		color: "#f59e0b",
		sortOrder: "a0",
	},
	{ key: "in_review", name: "In Review", category: "started", color: "#10b981", sortOrder: "a1" },
	{ key: "done", name: "Done", category: "completed", color: "#6366f1", sortOrder: "a0" },
	{ key: "canceled", name: "Canceled", category: "canceled", color: null, sortOrder: "a0" },
] as const satisfies readonly Pick<
	WorkflowStatus,
	"key" | "name" | "category" | "color" | "sortOrder"
>[];

export type DefaultStatusKey = (typeof DEFAULT_STATUSES)[number]["key"];

/** A new team's statuses. */
export function defaultStatuses(teamId: string, now: number): WorkflowStatus[] {
	return DEFAULT_STATUSES.map((status) => ({
		...status,
		id: statusId(teamId, status.key),
		teamId,
		createdAt: now,
		updatedAt: now,
		removedAt: null,
	}));
}

/** A team's order: by category, then by place within it. */
export function compareStatuses(
	a: Pick<WorkflowStatus, "category" | "sortOrder" | "key">,
	b: Pick<WorkflowStatus, "category" | "sortOrder" | "key">,
): number {
	const byCategory = STATUS_CATEGORIES.indexOf(a.category) - STATUS_CATEGORIES.indexOf(b.category);
	if (byCategory !== 0) return byCategory;
	if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A team's live statuses, in its order. */
export function liveStatuses<T extends WorkflowStatus>(statuses: Iterable<T>): T[] {
	return [...statuses].filter((status) => status.removedAt === null).sort(compareStatuses);
}

/** The status a new issue gets when it names none: the first of its team's statuses. */
export function firstStatus<T extends WorkflowStatus>(statuses: Iterable<T>): T | undefined {
	return liveStatuses(statuses)[0];
}

/**
 * The key for a new status called `name`: its letters and digits, lowercase and joined by
 * underscores, with a number added when `taken` (every key the team has used, removed ones
 * included) already has it.
 */
export function statusKeyFor(name: string, taken: ReadonlySet<string>): string {
	const words = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.join("_");
	let base = /^[a-z]/.test(words) ? words : `status_${words}`.replace(/_$/, "");
	base = base.slice(0, 28).replace(/_$/, "");
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const key = `${base}_${n}`;
		if (!taken.has(key)) return key;
	}
}
