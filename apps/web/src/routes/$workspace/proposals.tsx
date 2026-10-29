import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ProposalsPage } from "#/components/issues/proposals-page";
import { proposalsSearch } from "#/lib/proposals";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/proposals")({
	validateSearch: proposalsSearch,
	component: Proposals,
});

function Proposals() {
	const { agent } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	useDocumentTitle("Proposals");

	return (
		<ProposalsPage
			agentFilter={agent}
			onAgentFilterChange={(next) =>
				void navigate({ search: (prev) => ({ ...prev, agent: next }), replace: true })
			}
		/>
	);
}
