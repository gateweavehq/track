import { createFileRoute, Navigate } from "@tanstack/react-router";
import { CreateTeamForm } from "#/components/teams/create-team-dialog";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useTeams } from "#/lib/queries";

export const Route = createFileRoute("/$workspace/")({
	component: WorkspaceHome,
});

/** Opens the first team, or asks for one when the workspace is new. */
function WorkspaceHome() {
	const { workspace } = Route.useParams();
	const first = useTeams()[0];
	const admin = isAdmin(useMyRole());

	if (first) {
		return (
			<Navigate to="/$workspace/team/$teamKey" params={{ workspace, teamKey: first.key }} replace />
		);
	}
	if (!admin) {
		return (
			<Notice title="No teams yet">
				Issues live in teams, and only workspace admins can create them. Ask an admin to add one; it
				shows up here as soon as they do.
			</Notice>
		);
	}
	return (
		<div className="mx-auto max-w-sm space-y-6 px-6 py-24">
			<div className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Create your first team</h1>
				<p className="text-sm text-muted-foreground">
					Every issue belongs to a team. Start with one; you can add more at any time.
				</p>
			</div>
			<CreateTeamForm />
		</div>
	);
}
