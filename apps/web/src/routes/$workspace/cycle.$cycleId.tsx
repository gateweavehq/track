import type { Cycle, Team } from "@gateweave/track-protocol";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CycleDetails } from "#/components/cycles/cycle-details";
import { FILTER_KEYS } from "#/components/issues/filter-menu";
import { IssuesPage } from "#/components/issues/issues-page";
import { Button } from "#/components/ui/button";
import { SaveViewButton } from "#/components/views/view-controls";
import { useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { cycleName } from "#/lib/cycles";
import { hasDisplay } from "#/lib/display";
import { hasFilters } from "#/lib/filters";
import { useCycle, useCycleIssues, useTeamsById } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";
import {
	type IssuePageSearch,
	type IssueView,
	issuePageSearch,
	useIssueView,
	usePageDisplay,
	usePageFilters,
} from "#/lib/views";

// A cycle's page shows its issues, which are all of its team's.
const CYCLE_FILTERS = FILTER_KEYS.filter((key) => key !== "cycles" && key !== "teamIds");

export const Route = createFileRoute("/$workspace/cycle/$cycleId")({
	validateSearch: issuePageSearch,
	component: CyclePage,
});

function CyclePage() {
	const { workspace, cycleId } = Route.useParams();
	const cycle = useCycle(cycleId);
	const team = useTeamsById().get(cycle?.teamId ?? "");
	useDocumentTitle(cycle && team ? `${team.key} ${cycleName(cycle)}` : undefined);

	if (!cycle || !team) {
		return (
			<Notice
				title="Cycle not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace }}>
							Back to the workspace
						</Link>
					</Button>
				}
			>
				It may have been deleted when its team stopped working in cycles, or the link is wrong.
			</Notice>
		);
	}
	// Keyed by cycle, so switching cycles starts fresh: its own view, filter and selection.
	return <CycleIssues key={cycle.id} cycle={cycle} team={team} />;
}

function CycleIssues({ cycle, team }: { cycle: Cycle; team: Team }) {
	const { workspace } = Route.useParams();
	const actions = useWorkspaceActions();
	const issues = useCycleIssues(cycle.id);
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
	const scope = `cycle.${cycle.id}`;
	const [view, setView] = useIssueView(scope, search.view, setUrlView);
	const { filters, onFiltersChange } = usePageFilters(search, setSearch);
	const { display, onDisplayChange } = usePageDisplay(search, setSearch);
	// Issues can join a cycle only until it completes.
	const open = cycle.completedAt === null;
	const defaults = open ? { teamId: team.id, cycleId: cycle.id } : { teamId: team.id };

	return (
		<IssuesPage
			scope={scope}
			title={cycleName(cycle)}
			badge={
				<Link
					to="/$workspace/team/$teamKey/cycles"
					params={{ workspace, teamKey: team.key }}
					className="rounded border px-1.5 text-xs text-muted-foreground hover:text-foreground"
				>
					{team.key} cycles
				</Link>
			}
			intro={<CycleDetails cycle={cycle} team={team} />}
			issues={issues}
			defaults={defaults}
			view={view}
			onViewChange={setView}
			filters={filters}
			onFiltersChange={onFiltersChange}
			display={display}
			onDisplayChange={onDisplayChange}
			offeredFilters={CYCLE_FILTERS}
			filterActions={
				// A view shows issues from the whole workspace, so it keeps the cycle as a filter.
				(hasFilters(filters) || hasDisplay(display)) && (
					<SaveViewButton
						filters={{ ...filters, cycles: [cycle.id] }}
						layout={view}
						display={display}
					/>
				)
			}
			empty={
				<Notice
					title="No issues in this cycle"
					action={
						open && <Button onClick={() => actions.createIssue(defaults)}>Create issue</Button>
					}
				>
					{open
						? "Press C to create one here, or set the cycle on an existing issue."
						: "Its unfinished issues moved on to the next cycle when it ended."}
				</Notice>
			}
		/>
	);
}
