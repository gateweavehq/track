import { useSyncStatus } from "@gateweave/track-sync-client/react";
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CreateIssueDialog } from "#/components/issues/create-issue-dialog";
import { CreateProjectDialog } from "#/components/projects/create-project-dialog";
import { CreateTeamDialog } from "#/components/teams/create-team-dialog";
import { useHotkeys } from "#/lib/hotkeys";
import { parseIssueKey } from "#/lib/issues";
import { useProject, useTeamByKey, useTeams } from "#/lib/queries";
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
	// And they start with what the page of issues on screen asks for, such as what it is filtered
	// by, so they show up on it. A ref: a page changing its filters need not rebuild the actions.
	const pageDefaults = useRef<IssueDefaults | null>(null);

	const actions = useMemo<WorkspaceActions>(
		() => ({
			createIssue: (defaults = {}) => {
				if (hasTeams) {
					const page = pageDefaults.current ?? {};
					// `null` is a choice (no assignee, no project), so only `undefined` falls through.
					const first = <T,>(...values: (T | undefined)[]) =>
						values.find((value) => value !== undefined);
					setDialog({
						kind: "issue",
						defaults: {
							teamId: first(defaults.teamId, page.teamId, routeTeamId),
							status: first(defaults.status, page.status),
							priority: first(defaults.priority, page.priority),
							assigneeId: first(defaults.assigneeId, page.assigneeId),
							projectId: first(defaults.projectId, page.projectId, routeProjectId),
							labelIds: first(defaults.labelIds, page.labelIds),
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
			setPageDefaults: (defaults) => {
				pageDefaults.current = defaults;
			},
			openCommandPalette: () => setDialog({ kind: "palette" }),
			showShortcuts: () => setDialog({ kind: "shortcuts" }),
		}),
		[hasTeams, routeTeamId, routeProjectId, admin],
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
