import {
	type ActiveIssue,
	type Activity,
	type ArchivedIssue,
	type Comment,
	type Cycle,
	type InboxItem,
	type IssueRelation,
	type IssueTemplate,
	isActiveIssue,
	type Label,
	type Member,
	type Project,
	type ProjectUpdate,
	type Proposal,
	type PullRequest,
	privateId,
	type SavedView,
	type Subscription,
	type SyncedIssue,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { shallowEqual, useQuery } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { compareIssues } from "./issues";
import { compareLabels } from "./labels";
import { compareProjects, type ProjectProgress, projectProgress } from "./projects";
import { blockedIssueIds } from "./relations";
import { compareViews, isViewVisible } from "./saved-views";
import { type StatusMap, statusOf, teamStatuses } from "./statuses";
import { compareTemplates } from "./templates";

// Selectors over the synced state. Each hook keeps its selector stable for the inputs it
// depends on, so useQuery can skip work when unrelated parts of the state change.

const selectTeams = (state: SyncState) =>
	[...state.teams.values()].sort((a, b) => a.key.localeCompare(b.key));

export function useTeams(): Team[] {
	return useQuery(selectTeams, shallowEqual);
}

export function useTeamByKey(key: string): Team | undefined {
	const upper = key.toUpperCase();
	return useQuery(
		useCallback(
			(state: SyncState) => {
				for (const team of state.teams.values()) if (team.key === upper) return team;
				return undefined;
			},
			[upper],
		),
	);
}

const selectStatuses = (state: SyncState) => state.statuses;

/** Every team's statuses by id, removed ones included. */
export function useStatuses(): StatusMap {
	return useQuery(selectStatuses);
}

/** A team's statuses that issues can be in, in its order. Empty without a team. */
export function useTeamStatuses(teamId: string | undefined): WorkflowStatus[] {
	return useQuery(
		useCallback(
			(state: SyncState) => (teamId === undefined ? [] : teamStatuses(state.statuses, teamId)),
			[teamId],
		),
		shallowEqual,
	);
}

/** The status an issue is in, as its team names it. */
export function useIssueStatus(issue: Pick<SyncedIssue, "teamId" | "status">): WorkflowStatus {
	return statusOf(useStatuses(), issue);
}

const selectIssueCounts = (state: SyncState) => {
	const counts = new Map<string, number>();
	for (const issue of state.issues.values()) {
		counts.set(issue.teamId, (counts.get(issue.teamId) ?? 0) + 1);
	}
	return counts;
};

function countsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
	if (a.size !== b.size) return false;
	for (const [key, count] of a) if (b.get(key) !== count) return false;
	return true;
}

/** How many issues each team has, by team id. */
export function useIssueCountsByTeam(): ReadonlyMap<string, number> {
	return useQuery(selectIssueCounts, countsEqual);
}

/** How many of a team's issues are in each status, by key. */
export function useIssueCountsByStatus(teamId: string): ReadonlyMap<string, number> {
	return useQuery(
		useCallback(
			(state: SyncState) => {
				const counts = new Map<string, number>();
				for (const issue of state.issues.values()) {
					if (issue.teamId !== teamId) continue;
					counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
				}
				return counts;
			},
			[teamId],
		),
		countsEqual,
	);
}

const selectProjectList = (state: SyncState) => [...state.projects.values()].sort(compareProjects);

/** Live projects, open work first, for pickers. */
export function useProjectList(): Project[] {
	return useQuery(selectProjectList, shallowEqual);
}

const selectCyclesById = (state: SyncState) => state.cycles;

export function useCyclesById(): ReadonlyMap<string, Cycle> {
	return useQuery(selectCyclesById);
}

export function useCycle(id: string): Cycle | undefined {
	return useQuery(useCallback((state: SyncState) => state.cycles.get(id), [id]));
}

/** A team's cycles, oldest first. */
export function useTeamCycles(teamId: string | undefined): Cycle[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				[...state.cycles.values()]
					.filter((cycle) => cycle.teamId === teamId)
					.sort((a, b) => a.number - b.number),
			[teamId],
		),
		shallowEqual,
	);
}

/** A cycle's issues for its list: archived ones leave it. */
export function useCycleIssues(cycleId: string): ActiveIssue[] {
	return useIssues(
		useCallback((issue: ActiveIssue) => issue.cycleId === cycleId, [cycleId]),
		{ listed: true },
	);
}

/** Every issue of a cycle, archived ones as slim rows, for its progress. */
export function useAllCycleIssues(cycleId: string): SyncedIssue[] {
	return useIssues(useCallback((issue: SyncedIssue) => issue.cycleId === cycleId, [cycleId]));
}

const selectProjectsById = (state: SyncState) => state.projects;

export function useProjectsById(): ReadonlyMap<string, Project> {
	return useQuery(selectProjectsById);
}

export function useProject(id: string): Project | undefined {
	return useQuery(useCallback((state: SyncState) => state.projects.get(id), [id]));
}

/** A project with how many issues it has and how many of them are done. */
export interface ProjectSummary {
	project: Project;
	/** Every issue in the project. */
	issues: number;
	/** Done out of all that are not canceled. */
	progress: ProjectProgress;
}

const selectProjectSummaries = (state: SyncState): ProjectSummary[] => {
	const grouped = new Map<string, SyncedIssue[]>();
	for (const issue of state.issues.values()) {
		if (issue.projectId === null) continue;
		const group = grouped.get(issue.projectId);
		if (group) group.push(issue);
		else grouped.set(issue.projectId, [issue]);
	}
	return [...state.projects.values()].sort(compareProjects).map((project) => {
		const issues = grouped.get(project.id) ?? [];
		return { project, issues: issues.length, progress: projectProgress(issues, state.statuses) };
	});
};

function summariesEqual(a: readonly ProjectSummary[], b: readonly ProjectSummary[]) {
	return (
		a.length === b.length &&
		a.every((summary, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				summary.project === other.project &&
				summary.issues === other.issues &&
				summary.progress.done === other.progress.done &&
				summary.progress.total === other.progress.total
			);
		})
	);
}

/** Live projects with their issue counts and progress. */
export function useProjects(): ProjectSummary[] {
	return useQuery(selectProjectSummaries, summariesEqual);
}

const selectMembers = (state: SyncState) =>
	[...state.members.values()]
		.filter((member) => member.removedAt === null)
		.sort((a, b) => a.name.localeCompare(b.name));

/** Current members, for pickers. Removed members still resolve through `useMembersById`. */
export function useActiveMembers(): Member[] {
	return useQuery(selectMembers, shallowEqual);
}

const selectMembersById = (state: SyncState) => state.members;

export function useMembersById(): ReadonlyMap<string, Member> {
	return useQuery(selectMembersById);
}

const selectLabels = (state: SyncState) => [...state.labels.values()].sort(compareLabels);

export function useLabels(): Label[] {
	return useQuery(selectLabels, shallowEqual);
}

const selectTemplates = (state: SyncState) => [...state.templates.values()].sort(compareTemplates);

/** Every team's issue templates, by name. */
export function useTemplates(): IssueTemplate[] {
	return useQuery(selectTemplates, shallowEqual);
}

/** A team's issue templates, by name. Empty without a team. */
export function useTeamTemplates(teamId: string | undefined): IssueTemplate[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				[...state.templates.values()]
					.filter((template) => template.teamId === teamId)
					.sort(compareTemplates),
			[teamId],
		),
		shallowEqual,
	);
}

const selectLabelsById = (state: SyncState) => state.labels;

export function useLabelsById(): ReadonlyMap<string, Label> {
	return useQuery(selectLabelsById);
}

// An archived issue's labels stay on the server, so they count only the issues that are not.
const selectLabelCounts = (state: SyncState) => {
	const counts = new Map<string, number>();
	for (const issue of state.activeIssues.values()) {
		for (const labelId of issue.labelIds) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
	}
	return counts;
};

/** How many issues have each label, by label id. */
export function useIssueCountsByLabel(): ReadonlyMap<string, number> {
	return useQuery(selectLabelCounts, countsEqual);
}

/**
 * Rows grouped by issue, oldest first. Tables are replaced, never mutated, on every change, so
 * the grouping is computed once per version of a table, however many issue pages read it.
 */
function groupedByIssue<T extends { issueId: string; createdAt: number }>(
	cache: WeakMap<ReadonlyMap<string, T>, ReadonlyMap<string, T[]>>,
	table: ReadonlyMap<string, T>,
): ReadonlyMap<string, T[]> {
	let groups = cache.get(table);
	if (!groups) {
		const grouped = new Map<string, T[]>();
		for (const row of table.values()) {
			const rows = grouped.get(row.issueId);
			if (rows) rows.push(row);
			else grouped.set(row.issueId, [row]);
		}
		// A stable sort, so rows written in the same millisecond keep the server's order.
		for (const rows of grouped.values()) rows.sort((a, b) => a.createdAt - b.createdAt);
		groups = grouped;
		cache.set(table, groups);
	}
	return groups;
}

const NONE: never[] = [];
const commentGroups = new WeakMap<ReadonlyMap<string, Comment>, ReadonlyMap<string, Comment[]>>();
const activityGroups = new WeakMap<
	ReadonlyMap<string, Activity>,
	ReadonlyMap<string, Activity[]>
>();

export function useIssueComments(issueId: string): Comment[] {
	return useQuery(
		useCallback(
			(state: SyncState) => groupedByIssue(commentGroups, state.comments).get(issueId) ?? NONE,
			[issueId],
		),
		// Changes to other issues regroup the table but leave this issue's rows as they were.
		shallowEqual,
	);
}

const projectUpdateGroups = new WeakMap<
	ReadonlyMap<string, ProjectUpdate>,
	ReadonlyMap<string, ProjectUpdate[]>
>();

/** Each project's updates, the latest first, by project id. */
function updatesByProject(state: SyncState): ReadonlyMap<string, ProjectUpdate[]> {
	let groups = projectUpdateGroups.get(state.projectUpdates);
	if (!groups) {
		const grouped = new Map<string, ProjectUpdate[]>();
		for (const update of state.projectUpdates.values()) {
			const rows = grouped.get(update.projectId);
			if (rows) rows.push(update);
			else grouped.set(update.projectId, [update]);
		}
		for (const rows of grouped.values()) {
			rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
		}
		groups = grouped;
		projectUpdateGroups.set(state.projectUpdates, groups);
	}
	return groups;
}

/** A project's updates, the latest first. */
export function useProjectUpdates(projectId: string): ProjectUpdate[] {
	return useQuery(
		useCallback((state: SyncState) => updatesByProject(state).get(projectId) ?? NONE, [projectId]),
		shallowEqual,
	);
}

const selectLatestUpdates = (state: SyncState) => {
	const latest = new Map<string, ProjectUpdate>();
	for (const [projectId, updates] of updatesByProject(state)) {
		const first = updates[0];
		if (first) latest.set(projectId, first);
	}
	return latest;
};

function latestEqual(a: ReadonlyMap<string, ProjectUpdate>, b: ReadonlyMap<string, ProjectUpdate>) {
	if (a.size !== b.size) return false;
	for (const [key, update] of a) if (b.get(key) !== update) return false;
	return true;
}

/** Each project's latest update, which says how it is going now, by project id. */
export function useLatestProjectUpdates(): ReadonlyMap<string, ProjectUpdate> {
	return useQuery(selectLatestUpdates, latestEqual);
}

const proposalGroups = new WeakMap<
	ReadonlyMap<string, Proposal>,
	ReadonlyMap<string, Proposal[]>
>();

/** Agents' open proposals for an issue, oldest first. */
export function useIssueProposals(issueId: string): Proposal[] {
	return useQuery(
		useCallback(
			(state: SyncState) => groupedByIssue(proposalGroups, state.proposals).get(issueId) ?? NONE,
			[issueId],
		),
		shallowEqual,
	);
}

const selectProposals = (state: SyncState) => state.proposals;

/** Every open proposal of the workspace, by id. */
export function useProposals(): ReadonlyMap<string, Proposal> {
	return useQuery(selectProposals);
}

const selectProposalCount = (state: SyncState) => state.proposals.size;

export function useProposalCount(): number {
	return useQuery(selectProposalCount);
}

const selectIssuesById = (state: SyncState) => state.issues;

/** Every issue by id, an archived one as its slim row. */
export function useIssuesById(): ReadonlyMap<string, SyncedIssue> {
	return useQuery(selectIssuesById);
}

const selectActiveIssuesById = (state: SyncState) => state.activeIssues;

/** The issues that are not archived, whole, by id. */
export function useActiveIssuesById(): ReadonlyMap<string, ActiveIssue> {
	return useQuery(selectActiveIssuesById);
}

export function useIssueActivity(issueId: string): Activity[] {
	return useQuery(
		useCallback(
			(state: SyncState) => groupedByIssue(activityGroups, state.activities).get(issueId) ?? NONE,
			[issueId],
		),
		shallowEqual,
	);
}

const selectActivitiesById = (state: SyncState) => state.activities;

/** All issue history, for what is worked out from it across issues, such as a burn-up. */
export function useActivitiesById(): ReadonlyMap<string, Activity> {
	return useQuery(selectActivitiesById);
}

const selectTeamsById = (state: SyncState) => state.teams;

export function useTeamsById(): ReadonlyMap<string, Team> {
	return useQuery(selectTeamsById);
}

function kept<T extends SyncedIssue>(issues: ReadonlyMap<string, T>, keep: (issue: T) => boolean) {
	const rows: T[] = [];
	for (const issue of issues.values()) if (keep(issue)) rows.push(issue);
	return rows.sort(compareIssues);
}

/**
 * The issues `filter` keeps, in list order. With `listed`, only the issues lists show
 * (`isListed`), read from the issues that are not archived, so a large archive costs a list
 * nothing, and a change to an archived issue does not run its filter again. Without it, archived
 * issues come too, as their slim rows.
 */
export function useIssues(
	filter: (issue: ActiveIssue) => boolean,
	options: { listed: true },
): ActiveIssue[];
export function useIssues(filter: (issue: SyncedIssue) => boolean): SyncedIssue[];
export function useIssues(
	filter: (issue: ActiveIssue) => boolean,
	{ listed = false }: { listed?: boolean } = {},
): SyncedIssue[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				listed
					? kept(state.activeIssues, (issue) => isListed(issue) && filter(issue))
					: // Without `listed`, the overload takes a filter of any issue.
						kept(state.issues, filter as (issue: SyncedIssue) => boolean),
			[filter, listed],
		),
		shallowEqual,
	);
}

/**
 * Whether lists and boards show the issue. Archived issues leave them, and stay everywhere else
 * as slim rows: in search, in links, and in the progress of their project, cycle and parent.
 * Requests in intake wait on the team's intake page until someone accepts them.
 */
export function isListed(issue: SyncedIssue): issue is ActiveIssue {
	return isActiveIssue(issue) && !issue.intake;
}

/** A team's issues for its list: archived ones leave it. */
export function useTeamIssues(teamId: string | undefined): ActiveIssue[] {
	return useIssues(
		useCallback((issue: ActiveIssue) => issue.teamId === teamId, [teamId]),
		{ listed: true },
	);
}

/** A project's issues for its list: archived ones leave it. */
export function useProjectIssues(projectId: string): ActiveIssue[] {
	return useIssues(
		useCallback((issue: ActiveIssue) => issue.projectId === projectId, [projectId]),
		{ listed: true },
	);
}

/** Every issue of a project, archived ones as slim rows, for its progress. */
export function useAllProjectIssues(projectId: string): SyncedIssue[] {
	return useIssues(useCallback((issue: SyncedIssue) => issue.projectId === projectId, [projectId]));
}

/** The issues assigned to someone, for their list: archived ones leave it. */
export function useAssignedIssues(userId: string): ActiveIssue[] {
	return useIssues(
		useCallback((issue: ActiveIssue) => issue.assigneeId === userId, [userId]),
		{ listed: true },
	);
}

/** A team's archived issues, the latest archived first. */
export function useArchivedIssues(teamId: string): ArchivedIssue[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				[...state.issues.values()]
					.filter(
						(issue): issue is ArchivedIssue => issue.teamId === teamId && !isActiveIssue(issue),
					)
					.sort((a, b) => b.archivedAt - a.archivedAt),
			[teamId],
		),
		shallowEqual,
	);
}

/** A team's requests in intake, the oldest first, as they were filed. */
export function useIntakeIssues(teamId: string): ActiveIssue[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				[...state.activeIssues.values()]
					.filter((issue) => issue.teamId === teamId && issue.intake)
					.sort((a, b) => a.createdAt - b.createdAt || a.number - b.number),
			[teamId],
		),
		shallowEqual,
	);
}

/**
 * An issue by id, such as an issue's parent, an archived one as its slim row. Undefined for null
 * and for issues not in the copy.
 */
export function useIssueById(id: string | null): SyncedIssue | undefined {
	return useQuery(
		useCallback((state: SyncState) => (id === null ? undefined : state.issues.get(id)), [id]),
	);
}

/** An issue's sub-issues, archived ones last, as their slim rows. */
export function useSubIssues(parentId: string): SyncedIssue[] {
	return useIssues(useCallback((issue: SyncedIssue) => issue.parentId === parentId, [parentId]));
}

const selectSubIssueProgress = (state: SyncState): ReadonlyMap<string, ProjectProgress> => {
	const grouped = new Map<string, SyncedIssue[]>();
	for (const issue of state.issues.values()) {
		if (issue.parentId === null) continue;
		const group = grouped.get(issue.parentId);
		if (group) group.push(issue);
		else grouped.set(issue.parentId, [issue]);
	}
	return new Map(
		[...grouped].map(([parentId, issues]) => [parentId, projectProgress(issues, state.statuses)]),
	);
};

function progressByIdEqual(
	a: ReadonlyMap<string, ProjectProgress>,
	b: ReadonlyMap<string, ProjectProgress>,
) {
	if (a.size !== b.size) return false;
	for (const [id, progress] of a) {
		const other = b.get(id);
		if (!other || other.done !== progress.done || other.total !== progress.total) return false;
	}
	return true;
}

/** Each parent's sub-issues done, out of all that are not canceled, by the parent's id. */
export function useSubIssueProgress(): ReadonlyMap<string, ProjectProgress> {
	return useQuery(selectSubIssueProgress, progressByIdEqual);
}

const relationGroups = new WeakMap<
	ReadonlyMap<string, IssueRelation>,
	ReadonlyMap<string, IssueRelation[]>
>();

/** Relations by issue id, each under both its issues, oldest first. */
function relationsByIssue(
	table: ReadonlyMap<string, IssueRelation>,
): ReadonlyMap<string, IssueRelation[]> {
	let groups = relationGroups.get(table);
	if (!groups) {
		const grouped = new Map<string, IssueRelation[]>();
		const sorted = [...table.values()].sort((a, b) => a.createdAt - b.createdAt);
		for (const relation of sorted) {
			for (const issueId of [relation.issueId, relation.relatedIssueId]) {
				const rows = grouped.get(issueId);
				if (rows) rows.push(relation);
				else grouped.set(issueId, [relation]);
			}
		}
		groups = grouped;
		relationGroups.set(table, groups);
	}
	return groups;
}

const pullRequestGroups = new WeakMap<
	ReadonlyMap<string, PullRequest>,
	ReadonlyMap<string, PullRequest[]>
>();

/** Pull requests by each issue they mention, oldest first. Computed once per version of the table. */
function pullRequestsByIssue(table: ReadonlyMap<string, PullRequest>) {
	let groups = pullRequestGroups.get(table);
	if (!groups) {
		const grouped = new Map<string, PullRequest[]>();
		for (const pullRequest of table.values()) {
			for (const issueId of pullRequest.issueIds) {
				const rows = grouped.get(issueId);
				if (rows) rows.push(pullRequest);
				else grouped.set(issueId, [pullRequest]);
			}
		}
		for (const rows of grouped.values()) rows.sort((a, b) => a.createdAt - b.createdAt);
		groups = grouped;
		pullRequestGroups.set(table, groups);
	}
	return groups;
}

/** The pull requests on GitHub that mention an issue, oldest first. */
export function useIssuePullRequests(issueId: string): PullRequest[] {
	return useQuery(
		useCallback(
			(state: SyncState) => pullRequestsByIssue(state.pullRequests).get(issueId) ?? NONE,
			[issueId],
		),
		shallowEqual,
	);
}

/** An issue's relations, from either side, oldest first. */
export function useIssueRelations(issueId: string): IssueRelation[] {
	return useQuery(
		useCallback(
			(state: SyncState) => relationsByIssue(state.relations).get(issueId) ?? NONE,
			[issueId],
		),
		shallowEqual,
	);
}

const selectBlocked = (state: SyncState) =>
	blockedIssueIds(state.relations.values(), state.issues, state.statuses);

function setEqual(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

/** Open issues that an open issue blocks. */
export function useBlockedIssueIds(): ReadonlySet<string> {
	return useQuery(selectBlocked, setEqual);
}

/** An issue by its key's parts, an archived one as its slim row. */
export function useIssue(teamId: string | undefined, number: number): SyncedIssue | undefined {
	return useQuery(
		useCallback(
			(state: SyncState) => {
				for (const issue of state.issues.values()) {
					if (issue.teamId === teamId && issue.number === number) return issue;
				}
				return undefined;
			},
			[teamId, number],
		),
	);
}

/** The saved views a member sees: every shared one and their own, shared first, by name. */
export function useSavedViews(userId: string): SavedView[] {
	return useQuery(
		useCallback(
			(state: SyncState) =>
				[...state.views.values()].filter((view) => isViewVisible(view, userId)).sort(compareViews),
			[userId],
		),
		shallowEqual,
	);
}

/** A saved view by id, if it exists; whether the member may see it is the caller's to check. */
export function useSavedView(id: string): SavedView | undefined {
	return useQuery(useCallback((state: SyncState) => state.views.get(id), [id]));
}

const selectComments = (state: SyncState) => state.comments;

/** Every live comment of the workspace, by id. */
export function useCommentsById(): ReadonlyMap<string, Comment> {
	return useQuery(selectComments);
}

const selectInbox = (state: SyncState) => state.inbox;

/** The member's own inbox items, by id. */
export function useInbox(): ReadonlyMap<string, InboxItem> {
	return useQuery(selectInbox);
}

/** The member's inbox item for an issue, if the issue has been in their inbox. */
export function useInboxItem(issueId: string, userId: string): InboxItem | undefined {
	return useQuery(
		useCallback(
			(state: SyncState) => state.inbox.get(privateId(issueId, userId)),
			[issueId, userId],
		),
	);
}

/** The member's subscription to an issue: none until they or the server made one. */
export function useSubscription(issueId: string, userId: string): Subscription | undefined {
	return useQuery(
		useCallback(
			(state: SyncState) => state.subscriptions.get(privateId(issueId, userId)),
			[issueId, userId],
		),
	);
}
