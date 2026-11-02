import type { Issue } from "@gateweave/track-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { comboOf, isEditableTarget } from "#/lib/hotkeys";
import type { BulkField } from "./bulk-bar";

/**
 * The issues picked in a list, table or board to change together. Picks follow the issues the
 * page has, `pickable`: one that leaves them, filtered out, archived or deleted elsewhere, is
 * unpicked, and does not come back when it is there again. An issue only out of sight, in a
 * collapsed group, stays picked. Ranges and Ctrl/Cmd+A go by what is `shown`; Ctrl/Cmd+A does
 * nothing in a text field, or while a dialog, menu or list of options is open.
 */
export function useIssueSelection(shown: Issue[], pickable: Issue[] = shown) {
	const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [menu, setMenu] = useState<BulkField | null>(null);
	const anchor = useRef<string | null>(null);
	const order = useRef(shown);
	order.current = shown;

	const checked = pickable.filter((issue) => checkedIds.has(issue.id));
	// Statuses belong to a team, so the bar has no status menu for issues of several teams.
	const first = checked[0];
	const oneTeam = checked.every((issue) => issue.teamId === first?.teamId);

	// Forget picks that are no longer shown.
	useEffect(() => {
		if (checked.length === checkedIds.size) return;
		setCheckedIds(new Set(checked.map((issue) => issue.id)));
	}, [checked, checkedIds]);

	// A menu the bar cannot show is closed, so it does not open on its own later.
	useEffect(() => {
		if ((menu === "status" && !oneTeam) || (menu !== null && checked.length === 0)) setMenu(null);
	}, [menu, oneTeam, checked.length]);

	/** Picks or unpicks an issue; with `range`, everything between it and the last one picked. */
	const onCheck = useCallback((issueId: string, range: boolean) => {
		const ids = order.current.map((issue) => issue.id);
		const from = anchor.current === null ? -1 : ids.indexOf(anchor.current);
		const to = ids.indexOf(issueId);
		setCheckedIds((current) => {
			const next = new Set(current);
			if (range && from !== -1 && to !== -1) {
				for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
			} else if (!next.delete(issueId)) {
				next.add(issueId);
			}
			return next;
		});
		anchor.current = issueId;
	}, []);

	const selectAll = useCallback(() => {
		// Added to the picks, so those in collapsed groups stay.
		setCheckedIds((current) => new Set([...current, ...order.current.map((issue) => issue.id)]));
	}, []);

	const clear = useCallback(() => {
		setCheckedIds(new Set());
		setMenu(null);
		anchor.current = null;
	}, []);

	/** Opens one of the bar's menus from the keyboard, if the bar shows it for these issues. */
	const openMenu = (field: BulkField) => {
		if (checked.length === 0 || (field === "status" && !oneTeam)) return;
		setMenu(field);
	};

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (comboOf(event) !== "mod+a" || event.defaultPrevented) return;
			if (isEditableTarget(event.target)) return;
			if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
			if (order.current.length === 0) return;
			event.preventDefault();
			selectAll();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectAll]);

	return {
		checkedIds,
		checked,
		checking: checked.length > 0,
		onCheck,
		selectAll,
		clear,
		menu,
		setMenu,
		openMenu,
	};
}
