import {
	type IssuePriority,
	type IssueStatus,
	isAdminRole,
	type MemberRole,
} from "@gateweave/track-protocol";
import { createContext, type ReactNode, useContext } from "react";
import { useMembersById } from "#/lib/queries";

export interface WorkspaceInfo {
	id: string;
	slug: string;
	name: string;
	userId: string;
	role: MemberRole;
	/** True on the public demo, which shows a banner. */
	demo?: boolean;
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
	return isAdminRole(role);
}

/** Values a new issue starts with, taken from where the user opened the dialog. */
export interface IssueDefaults {
	teamId?: string;
	status?: IssueStatus;
	priority?: IssuePriority;
	assigneeId?: string | null;
	projectId?: string | null;
	labelIds?: string[];
}

/** Workspace-wide actions, available to pages, the sidebar and keyboard shortcuts. */
export interface WorkspaceActions {
	createIssue: (defaults?: IssueDefaults) => void;
	createTeam: () => void;
	createProject: () => void;
	/**
	 * What new issues start with while a page of issues is on screen, unless a caller says
	 * otherwise; null when the page goes. The page sets it, so the shortcut, the command palette
	 * and the sidebar's button make issues that show up on it.
	 */
	setPageDefaults: (defaults: IssueDefaults | null) => void;
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
