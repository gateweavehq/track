import { useCallback, useState } from "react";
import { z } from "zod";

export const ISSUE_VIEWS = ["list", "board"] as const;
export type IssueView = (typeof ISSUE_VIEWS)[number];

/** Search params for a page of issues. A missing or unknown view falls back to the default. */
export const issueViewSearch = z.object({
	view: z.enum(ISSUE_VIEWS).optional().catch(undefined),
});

const storageKey = (scope: string) => `tangent.view.${scope}`;

function readView(scope: string): IssueView | null {
	try {
		const value = localStorage.getItem(storageKey(scope));
		return value === "list" || value === "board" ? value : null;
	} catch {
		// Storage can be unavailable, for example in a locked-down private window.
		return null;
	}
}

function writeView(scope: string, view: IssueView) {
	try {
		localStorage.setItem(storageKey(scope), view);
	} catch {
		// Remembering the view is a convenience; the URL still carries it.
	}
}

/**
 * The view of a page of issues: the one in the URL, else the one last used on this page (its
 * `scope`), else the list. Choosing a view remembers it and puts it in the URL, so links to a
 * board open as a board. Remount the caller when `scope` changes.
 */
export function useIssueView(
	scope: string,
	fromUrl: IssueView | undefined,
	setUrl: (view: IssueView) => void,
): [IssueView, (view: IssueView) => void] {
	const [remembered, setRemembered] = useState(() => readView(scope));
	const change = useCallback(
		(view: IssueView) => {
			writeView(scope, view);
			setRemembered(view);
			setUrl(view);
		},
		[scope, setUrl],
	);
	return [fromUrl ?? remembered ?? "list", change];
}
