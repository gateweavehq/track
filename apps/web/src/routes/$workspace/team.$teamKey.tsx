import type { Team } from "@gateweave/track-protocol";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { FILTER_KEYS } from "#/components/issues/filter-menu";
import { IssuesPage } from "#/components/issues/issues-page";
import { Button } from "#/components/ui/button";
import { SaveViewButton } from "#/components/views/view-controls";
import { useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { hasDisplay } from "#/lib/display";
import { hasFilters } from "#/lib/filters";
import { useTeamByKey, useTeamIssues } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import {
	type IssuePageSearch,
	type IssueView,
	issuePageSearch,
	useIssueView,
	usePageDisplay,
	usePageFilters,
} from "#/lib/views";

// A team's page shows that team's issues.
const TEAM_FILTERS = FILTER_KEYS.filter((key) => key !== "teamIds");

export const Route = createFileRoute("/$workspace/team/$teamKey")({
	validateSearch: issuePageSearch,
	component: TeamPage,
});

function TeamPage() {
	const { workspace, teamKey } = Route.useParams();
	const team = useTeamByKey(teamKey);
	useDocumentTitle(team?.name);

	if (!team) {
		return (
			<Notice
				title="Team not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace }}>
							Back to the workspace
						</Link>
					</Button>
				}
			>
				No team in this workspace uses the key {teamKey.toUpperCase()}.
			</Notice>
		);
	}
	// Keyed by team, so switching teams starts fresh: its own view, filter and selection.
	return <TeamIssues key={team.id} team={team} />;
}

function TeamIssues({ team }: { team: Team }) {
	const actions = useWorkspaceActions();
	const issues = useTeamIssues(team.id);
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const setSearch = useCallback(
		(patch: IssuePageSearch | ((current: IssuePageSearch) => IssuePageSearch)) =>
			void navigate({
				// A function patch is applied to the search as it is then, not as this render saw it.
				search: (prev) => ({ ...prev, ...(typeof patch === "function" ? patch(prev) : patch) }),
				replace: true,
			}),
		[navigate],
	);
	const setUrlView = useCallback((view: IssueView) => setSearch({ view }), [setSearch]);
	const scope = `team.${team.id}`;
	const [view, setView] = useIssueView(scope, search.view, setUrlView);
	const { filters, onFiltersChange } = usePageFilters(search, setSearch);
	const { display, onDisplayChange } = usePageDisplay(search, setSearch);

	return (
		<IssuesPage
			scope={scope}
			title={team.name}
			badge={
				<span className="rounded border px-1.5 font-mono text-xs text-muted-foreground">
					{team.key}
				</span>
			}
			issues={issues}
			defaults={{ teamId: team.id }}
			view={view}
			onViewChange={setView}
			filters={filters}
			onFiltersChange={onFiltersChange}
			display={display}
			onDisplayChange={onDisplayChange}
			offeredFilters={TEAM_FILTERS}
			filterActions={
				// A view shows issues from the whole workspace, so it keeps the team as a filter.
				(hasFilters(filters) || hasDisplay(display)) && (
					<SaveViewButton
						filters={{ ...filters, teamIds: [team.id] }}
						layout={view}
						display={display}
					/>
				)
			}
			empty={
				<Notice
					title="No issues yet"
					action={
						<Button onClick={() => actions.createIssue({ teamId: team.id })}>Create issue</Button>
					}
				>
					Press C anywhere to create one.
				</Notice>
			}
		/>
	);
}
