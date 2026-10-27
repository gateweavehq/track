import { useSyncStatus } from "@gateweave/track-sync-client/react";
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateIssueDialog } from "#/components/issues/create-issue-dialog";
import { CreateTeamDialog } from "#/components/teams/create-team-dialog";
import { useHotkeys } from "#/lib/hotkeys";
import { parseIssueKey } from "#/lib/issues";
import { useTeamByKey, useTeams } from "#/lib/queries";
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

	const actions = useMemo<WorkspaceActions>(
		() => ({
			createIssue: (defaults = {}) => {
				if (hasTeams) {
					setDialog({
						kind: "issue",
						defaults: { ...defaults, teamId: defaults.teamId ?? routeTeamId },
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
			openCommandPalette: () => setDialog({ kind: "palette" }),
			showShortcuts: () => setDialog({ kind: "shortcuts" }),
		}),
		[hasTeams, routeTeamId, admin],
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
			{dialog?.kind === "palette" && <CommandPalette onClose={close} />}
			{dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={close} />}
		</WorkspaceActionsContext>
	);
}
