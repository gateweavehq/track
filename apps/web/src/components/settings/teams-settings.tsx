import type { Team } from "@tangent/protocol";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { EditTeamDialog } from "#/components/teams/edit-team-dialog";
import { Button } from "#/components/ui/button";
import {
	isAdmin,
	useMyRole,
	useWorkspace,
	useWorkspaceActions,
} from "#/components/workspace/context";
import { useIssueCountsByTeam, useTeams } from "#/lib/queries";

export function TeamsSettings() {
	const { slug } = useWorkspace();
	const actions = useWorkspaceActions();
	const admin = isAdmin(useMyRole());
	const teams = useTeams();
	const counts = useIssueCountsByTeam();
	const [editing, setEditing] = useState<Team | null>(null);

	return (
		<section aria-labelledby="teams-heading" className="space-y-4">
			<div className="flex items-end justify-between gap-4">
				<div className="space-y-1">
					<h2 id="teams-heading" className="text-base font-semibold">
						Teams
					</h2>
					<p className="text-sm text-muted-foreground">
						Every issue belongs to a team, and its identifier starts with the team's key.
						{!admin && " Admins create and edit teams."}
					</p>
				</div>
				{admin && (
					<Button size="sm" onClick={actions.createTeam}>
						<Plus />
						Create team
					</Button>
				)}
			</div>
			{teams.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					No teams yet.
				</p>
			) : (
				<ul className="divide-y rounded-lg border">
					{teams.map((team) => {
						const count = counts.get(team.id) ?? 0;
						return (
							<li key={team.id} className="flex items-center gap-3 px-4 py-3">
								<span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
									{team.key}
								</span>
								<Link
									to="/$workspace/team/$teamKey"
									params={{ workspace: slug, teamKey: team.key }}
									className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
								>
									{team.name}
								</Link>
								<span className="text-xs text-muted-foreground tabular-nums">
									{count === 1 ? "1 issue" : `${count} issues`}
								</span>
								{admin && (
									<Button variant="ghost" size="sm" onClick={() => setEditing(team)}>
										Edit
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{editing && <EditTeamDialog team={editing} onClose={() => setEditing(null)} />}
		</section>
	);
}
