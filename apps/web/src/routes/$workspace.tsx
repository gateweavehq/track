import type { Snapshot } from "@tangent/protocol";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { getSession } from "#/lib/session";

// Placeholder until the client sync engine and workspace UI land: shows that the authenticated
// gateway to the workspace's Durable Object works end to end.
export const Route = createFileRoute("/$workspace")({
	ssr: false,
	beforeLoad: async () => {
		if (!(await getSession())) throw redirect({ to: "/login" });
	},
	loader: async ({ params }) => {
		const response = await fetch(`/api/sync/${encodeURIComponent(params.workspace)}/snapshot`);
		if (response.status === 404) throw notFound();
		if (!response.ok) throw new Error(`Snapshot failed with ${response.status}`);
		return (await response.json()) as Snapshot;
	},
	component: WorkspacePage,
});

function WorkspacePage() {
	const snapshot = Route.useLoaderData();
	const { workspace } = Route.useParams();

	return (
		<main className="mx-auto max-w-lg space-y-6 p-6 pt-24">
			<Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
				← Workspaces
			</Link>
			<h1 className="text-xl font-semibold tracking-tight">/{workspace}</h1>
			<dl className="grid grid-cols-4 gap-3 text-sm">
				{(
					[
						["Version", snapshot.version],
						["Teams", snapshot.teams.length],
						["Issues", snapshot.issues.length],
						["Members", snapshot.members.length],
					] as const
				).map(([label, value]) => (
					<div key={label} className="rounded-lg border p-3">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="text-lg font-semibold tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
		</main>
	);
}
