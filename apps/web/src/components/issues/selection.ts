import type { Issue } from "@gateweave/track-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { comboOf, isEditableTarget } from "#/lib/hotkeys";
import type { BulkField } from "./bulk-bar";

/**
 * The issues picked in a list or table to change together. Picked issues that leave what is
 * shown, filtered out or deleted elsewhere, are no longer picked. Ctrl/Cmd+A picks everything
 * shown, unless the keyboard is in a text field or an open menu, where it selects text as usual.
 */
export function useIssueSelection(shown: Issue[]) {
	const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
	const [menu, setMenu] = useState<BulkField | null>(null);
	const anchor = useRef<string | null>(null);
	const order = useRef(shown);
	order.current = shown;

	const checked = shown.filter((issue) => checkedIds.has(issue.id));

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
		setCheckedIds(new Set(order.current.map((issue) => issue.id)));
	}, []);

	const clear = useCallback(() => {
		setCheckedIds(new Set());
		setMenu(null);
		anchor.current = null;
	}, []);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (comboOf(event) !== "mod+a" || event.defaultPrevented) return;
			if (isEditableTarget(event.target) || document.querySelector('[role="dialog"]')) return;
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
	};
}
