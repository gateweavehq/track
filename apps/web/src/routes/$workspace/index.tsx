import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { CreateTeamForm } from "#/components/teams/create-team-dialog";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useTeams } from "#/lib/queries";
import { startGuidedTeam } from "#/lib/workspace";

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
			<GuidedStart workspace={workspace} />
		</div>
	);
}

/** The other way to begin: a team named after the workspace, with issues that show Track. */
function GuidedStart({ workspace }: { workspace: string }) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function start() {
		setPending(true);
		setError(null);
		const result = await startGuidedTeam({ data: workspace }).catch((cause: unknown) => ({
			ok: false as const,
			message: cause instanceof Error ? cause.message : String(cause),
		}));
		setPending(false);
		// On success the team arrives through sync, and the page opens it.
		if (!result.ok) setError(result.message);
	}

	return (
		<div className="space-y-2 border-t pt-6">
			<p className="text-sm text-muted-foreground">
				New to Track? Start with a team and a few issues that show you around.
			</p>
			<Button type="button" variant="outline" onClick={start} disabled={pending}>
				Start with a guided team
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
