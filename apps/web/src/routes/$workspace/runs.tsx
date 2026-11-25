import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RunsOverviewPage } from "#/components/runs/runs-overview-page";
import { runsOverviewSearch } from "#/lib/runs-overview";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/runs")({
	validateSearch: runsOverviewSearch,
	component: Runs,
});

function Runs() {
	const filter = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	useDocumentTitle("Runs");

	return (
		<RunsOverviewPage
			filter={filter}
			onFilterChange={(next) =>
				void navigate({
					search: (prev) => ({ ...prev, executor: next.executor, repository: next.repository }),
					replace: true,
				})
			}
		/>
	);
}
