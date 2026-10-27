import type { Issue, Member, Team } from "@tangent/protocol";
import type { SyncState } from "@tangent/sync-client";
import { shallowEqual, useQuery } from "@tangent/sync-client/react";
import { useCallback } from "react";
import { compareIssues } from "./issues";

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

export function useAssignedIssues(userId: string): Issue[] {
	return useIssues(useCallback((issue: Issue) => issue.assigneeId === userId, [userId]));
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
