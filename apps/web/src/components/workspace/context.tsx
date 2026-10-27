import type { IssueStatus, MemberRole } from "@gateweave/track-protocol";
import { createContext, type ReactNode, useContext } from "react";
import { useMembersById } from "#/lib/queries";

export interface WorkspaceInfo {
	id: string;
	slug: string;
	name: string;
	userId: string;
	role: MemberRole;
}

const WorkspaceContext = createContext<WorkspaceInfo | null>(null);

export function WorkspaceProvider({
	workspace,
	children,
}: {
	workspace: WorkspaceInfo;
	children: ReactNode;
}) {
	return <WorkspaceContext value={workspace}>{children}</WorkspaceContext>;
}

export function useWorkspace(): WorkspaceInfo {
	const workspace = useContext(WorkspaceContext);
	if (!workspace) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
	return workspace;
}

/**
 * The signed-in user's role. Sync keeps it current, so a promotion or demotion shows up without
 * a reload. The server checks every action again; this only decides what to offer.
 */
export function useMyRole(): MemberRole {
	const { userId, role } = useWorkspace();
	return useMembersById().get(userId)?.role ?? role;
}

/** Owners and admins manage teams, members and invitations. */
export function isAdmin(role: MemberRole): boolean {
	return role !== "member";
}

/** Values a new issue starts with, taken from where the user opened the dialog. */
export interface IssueDefaults {
	teamId?: string;
	status?: IssueStatus;
	assigneeId?: string | null;
}

/** Workspace-wide actions, available to pages, the sidebar and keyboard shortcuts. */
export interface WorkspaceActions {
	createIssue: (defaults?: IssueDefaults) => void;
	createTeam: () => void;
	openCommandPalette: () => void;
	showShortcuts: () => void;
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);

export function useWorkspaceActions(): WorkspaceActions {
	const actions = useContext(WorkspaceActionsContext);
	if (!actions)
		throw new Error("useWorkspaceActions must be used inside <WorkspaceActionsProvider>");
	return actions;
}
