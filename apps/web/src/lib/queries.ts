import type {
	Activity,
	Comment,
	Issue,
	Label,
	Member,
	Project,
	Proposal,
	Team,
} from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { shallowEqual, useQuery } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { compareIssues } from "./issues";
import { compareLabels } from "./labels";
import { compareProjects, type ProjectProgress, projectProgress } from "./projects";

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

const selectProjectList = (state: SyncState) => [...state.projects.values()].sort(compareProjects);

/** Live projects, open work first, for pickers. */
export function useProjectList(): Project[] {
	return useQuery(selectProjectList, shallowEqual);
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
	const grouped = new Map<string, Issue[]>();
	for (const issue of state.issues.values()) {
		if (issue.projectId === null) continue;
		const group = grouped.get(issue.projectId);
		if (group) group.push(issue);
		else grouped.set(issue.projectId, [issue]);
	}
	return [...state.projects.values()].sort(compareProjects).map((project) => {
		const issues = grouped.get(project.id) ?? [];
		return { project, issues: issues.length, progress: projectProgress(issues) };
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

const selectLabelsById = (state: SyncState) => state.labels;

export function useLabelsById(): ReadonlyMap<string, Label> {
	return useQuery(selectLabelsById);
}

const selectLabelCounts = (state: SyncState) => {
	const counts = new Map<string, number>();
	for (const issue of state.issues.values()) {
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

export function useIssuesById(): ReadonlyMap<string, Issue> {
	return useQuery(selectIssuesById);
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

const selectTeamsById = (state: SyncState) => state.teams;

export function useTeamsById(): ReadonlyMap<string, Team> {
	return useQuery(selectTeamsById);
}

export function useIssues(filter: (issue: Issue) => boolean): Issue[] {
	return useQuery(
		useCallback(
			(state: SyncState) => [...state.issues.values()].filter(filter).sort(compareIssues),
			[filter],
		),
		shallowEqual,
	);
}

export function useTeamIssues(teamId: string | undefined): Issue[] {
	return useIssues(useCallback((issue: Issue) => issue.teamId === teamId, [teamId]));
}

export function useProjectIssues(projectId: string): Issue[] {
	return useIssues(useCallback((issue: Issue) => issue.projectId === projectId, [projectId]));
}

export function useAssignedIssues(userId: string): Issue[] {
	return useIssues(useCallback((issue: Issue) => issue.assigneeId === userId, [userId]));
}

/** An issue by id, such as an issue's parent. Undefined for null and for issues not in the copy. */
export function useIssueById(id: string | null): Issue | undefined {
	return useQuery(
		useCallback((state: SyncState) => (id === null ? undefined : state.issues.get(id)), [id]),
	);
}

export function useSubIssues(parentId: string): Issue[] {
	return useIssues(useCallback((issue: Issue) => issue.parentId === parentId, [parentId]));
}

const selectSubIssueProgress = (state: SyncState): ReadonlyMap<string, ProjectProgress> => {
	const grouped = new Map<string, Issue[]>();
	for (const issue of state.issues.values()) {
		if (issue.parentId === null) continue;
		const group = grouped.get(issue.parentId);
		if (group) group.push(issue);
		else grouped.set(issue.parentId, [issue]);
	}
	return new Map([...grouped].map(([parentId, issues]) => [parentId, projectProgress(issues)]));
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

export function useIssue(teamId: string | undefined, number: number): Issue | undefined {
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
