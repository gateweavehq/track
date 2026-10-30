import { isAdminRole, type MemberRole, type SavedView } from "@gateweave/track-protocol";

// Saved views (`SavedView` in the protocol): filters and a layout under a name. Shared ones are
// the workspace's; personal ones are their owner's, and the app shows them to no one else.

/** Whether a member sees a view in the app: every shared view, and their own personal ones. */
export function isViewVisible(view: SavedView, userId: string): boolean {
	return view.ownerId === null || view.ownerId === userId;
}

/** The server's rule: a personal view is its owner's; a shared one its creator's and admins'. */
export function canEditView(view: SavedView, userId: string, role: MemberRole): boolean {
	if (view.ownerId !== null) return view.ownerId === userId;
	return view.creatorId === userId || isAdminRole(role);
}

/** Shared views first, then personal ones, each by name. */
export function compareViews(a: SavedView, b: SavedView): number {
	return (
		Number(a.ownerId !== null) - Number(b.ownerId !== null) ||
		a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
		a.id.localeCompare(b.id)
	);
}
