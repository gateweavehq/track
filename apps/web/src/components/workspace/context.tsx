import type { IssueStatus, MemberRole } from "@tangent/protocol";
import { createContext, type ReactNode, useContext } from "react";

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
