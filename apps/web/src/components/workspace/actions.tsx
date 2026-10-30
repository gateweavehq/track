import { useSyncStatus } from "@gateweave/track-sync-client/react";
import { useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateIssueDialog } from "#/components/issues/create-issue-dialog";
import { CreateProjectDialog } from "#/components/projects/create-project-dialog";
import { CreateTeamDialog } from "#/components/teams/create-team-dialog";
import { useHotkeys } from "#/lib/hotkeys";
import { parseIssueKey } from "#/lib/issues";
import { useProject, useTeamByKey, useTeams } from "#/lib/queries";
import { issuePageSearch } from "#/lib/views";
import { CommandPalette } from "./command-palette";
import {
	type IssueDefaults,
	isAdmin,
	useMyRole,
	type WorkspaceActions,
	WorkspaceActionsContext,
} from "./context";
import { ShortcutsDialog } from "./shortcuts-dialog";

type OpenDialog =
	| { kind: "issue"; defaults: IssueDefaults }
	| { kind: "team" }
	| { kind: "project" }
	| { kind: "palette" }
	| { kind: "shortcuts" }
	| null;

/** The one value of a filter that has exactly one. */
function only<T>(values: readonly T[] | undefined): T | undefined {
	return values?.length === 1 ? values[0] : undefined;
}

/** Owns the workspace's dialogs and global shortcuts, and offers them to the rest of the UI. */
export function WorkspaceActionsProvider({ children }: { children: ReactNode }) {
	const [dialog, setDialog] = useState<OpenDialog>(null);
	const hasTeams = useTeams().length > 0;
	const admin = isAdmin(useMyRole());
	// New issues go to the team on screen, whether that is a team's list or one of its issues.
	const params = useParams({ strict: false });
	const routeTeamKey = params.teamKey ?? parseIssueKey(params.issueKey ?? "")?.teamKey ?? "";
	const routeTeamId = useTeamByKey(routeTeamKey)?.id;
	// And to the project on screen, which only counts while it exists.
	const routeProjectId = useProject(params.projectId ?? "")?.id;
	// And they start with what the page is filtered by, so they show up on it: its labels, and a
	// status, priority, assignee, project or team when it is filtered to just one. Parsed only when
	// used, so the raw values keep their identity between renders.
	const search = useSearch({ strict: false });
	const routeLabels = search.labels;
	const routeTeam = search.team;
	const routeStatus = search.status;
	const routePriority = search.priority;
	const routeAssignee = search.assignee;
	const routeProject = search.project;

	const actions = useMemo<WorkspaceActions>(
		() => ({
			createIssue: (defaults = {}) => {
				if (hasTeams) {
					setDialog({
						kind: "issue",
						defaults: {
							...defaults,
							teamId:
								defaults.teamId ?? routeTeamId ?? only(issuePageSearch.shape.team.parse(routeTeam)),
							status: defaults.status ?? only(issuePageSearch.shape.status.parse(routeStatus)),
							priority:
								defaults.priority ?? only(issuePageSearch.shape.priority.parse(routePriority)),
							assigneeId:
								defaults.assigneeId === undefined
									? only(issuePageSearch.shape.assignee.parse(routeAssignee))
									: defaults.assigneeId,
							projectId:
								defaults.projectId === undefined
									? (routeProjectId ?? only(issuePageSearch.shape.project.parse(routeProject)))
									: defaults.projectId,
							labelIds: defaults.labelIds ?? issuePageSearch.shape.labels.parse(routeLabels),
						},
					});
				} else if (admin) {
					// Issues need a team, so the first one comes first.
					setDialog({ kind: "team" });
				} else {
					toast.info("No teams yet", { description: "Ask a workspace admin to create one." });
				}
			},
			// Only admins manage teams. The UI hides the way in for others; this is the backstop.
			createTeam: () => admin && setDialog({ kind: "team" }),
			// Any person can make a project; the server refuses agents, which never use this UI.
			createProject: () => setDialog({ kind: "project" }),
			openCommandPalette: () => setDialog({ kind: "palette" }),
			showShortcuts: () => setDialog({ kind: "shortcuts" }),
		}),
		[
			hasTeams,
			routeTeamId,
			routeProjectId,
			routeLabels,
			routeStatus,
			routePriority,
			routeAssignee,
			routeProject,
			routeTeam,
			admin,
		],
	);

	const { loaded } = useSyncStatus();
	useHotkeys(
		{
			// Toggles the palette, but never replaces another dialog and the work in it.
			"mod+k": () =>
				setDialog((open) =>
					open === null ? { kind: "palette" } : open.kind === "palette" ? null : open,
				),
			c: () => actions.createIssue(),
			"?": actions.showShortcuts,
		},
		loaded,
	);

	const close = () => setDialog(null);
	return (
		<WorkspaceActionsContext value={actions}>
			{children}
			{dialog?.kind === "issue" && <CreateIssueDialog defaults={dialog.defaults} onClose={close} />}
			{dialog?.kind === "team" && <CreateTeamDialog onClose={close} />}
			{dialog?.kind === "project" && <CreateProjectDialog onClose={close} />}
			{dialog?.kind === "palette" && <CommandPalette onClose={close} />}
			{dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={close} />}
		</WorkspaceActionsContext>
	);
}
