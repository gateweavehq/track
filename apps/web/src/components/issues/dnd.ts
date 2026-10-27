import {
	draggable,
	dropTargetForElements,
	monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge";
import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types";
import { ISSUE_STATUSES, type Issue, type IssueStatus } from "@tangent/protocol";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { planMove, type StatusGroup } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";

type Data = Record<string | symbol, unknown>;

const ISSUE_DRAG = "tangent/issue";

function draggedIssueId(data: Data): string | null {
	return data.kind === ISSUE_DRAG && typeof data.issueId === "string" ? data.issueId : null;
}

/** Where a group drop zone puts an issue dropped on it rather than on one of its issues. */
type GroupEnd = "start" | "end";

type DropTarget =
	| { target: "issue"; issueId: string }
	| { target: "group"; status: IssueStatus; at: GroupEnd };

function isStatus(value: unknown): value is IssueStatus {
	return (ISSUE_STATUSES as readonly unknown[]).includes(value);
}

function parseDropTarget(data: Data): DropTarget | null {
	if (data.target === "issue" && typeof data.issueId === "string") {
		return { target: "issue", issueId: data.issueId };
	}
	if (data.target === "group" && isStatus(data.status)) {
		return { target: "group", status: data.status, at: data.at === "start" ? "start" : "end" };
	}
	return null;
}

export interface DragState {
	/** This issue is the one being dragged. */
	dragging: boolean;
	/** Another issue is over this one, and would land on this edge of it. */
	edge: Edge | null;
}

const IDLE: DragState = { dragging: false, edge: null };

/**
 * Makes an element (a row or a card) draggable, and a drop target that reports which half of it
 * the dragged issue is over.
 */
export function useDraggableIssue<T extends HTMLElement>(
	issueId: string,
): [RefObject<T | null>, DragState] {
	const ref = useRef<T>(null);
	const [state, setState] = useState(IDLE);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const setEdge = (edge: Edge | null) =>
			setState((current) => (current.edge === edge ? current : { ...current, edge }));
		return combine(
			draggable({
				element,
				getInitialData: () => ({ kind: ISSUE_DRAG, issueId }),
				onDragStart: () => setState({ dragging: true, edge: null }),
				onDrop: () => setState(IDLE),
			}),
			dropTargetForElements({
				element,
				canDrop: ({ source }) => draggedIssueId(source.data) !== null,
				getData: ({ input }) =>
					attachClosestEdge(
						{ target: "issue", issueId },
						{ element, input, allowedEdges: ["top", "bottom"] },
					),
				onDrag: ({ self, source }) =>
					setEdge(draggedIssueId(source.data) === issueId ? null : extractClosestEdge(self.data)),
				onDragLeave: () => setEdge(null),
				onDrop: () => setEdge(null),
			}),
		);
	}, [issueId]);

	return [ref, state];
}

/**
 * Makes an element a drop zone for a status: a board column, or a list's group header. Returns
 * whether an issue is being dragged over it.
 */
export function useIssueDropZone<T extends HTMLElement>(
	status: IssueStatus,
	at: GroupEnd,
): [RefObject<T | null>, boolean] {
	const ref = useRef<T>(null);
	const [over, setOver] = useState(false);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		return dropTargetForElements({
			element,
			canDrop: ({ source }) => draggedIssueId(source.data) !== null,
			getData: () => ({ target: "group", status, at }),
			onDragEnter: () => setOver(true),
			onDragLeave: () => setOver(false),
			onDrop: () => setOver(false),
		});
	}, [status, at]);

	return [ref, over];
}

/** Scrolls an element while an issue is dragged near its edges. */
export function useDragAutoScroll(ref: RefObject<HTMLElement | null>, enabled = true) {
	useEffect(() => {
		const element = ref.current;
		if (!element || !enabled) return;
		return autoScrollForElements({ element });
	}, [ref, enabled]);
}

/**
 * Moves issues among `groups`: returns a function that moves an issue to a position in a status,
 * and applies drops onto rows, cards and drop zones with it.
 */
export function useIssueMoves(groups: readonly StatusGroup[]) {
	const update = useUpdateIssue();
	const latest = useRef(groups);
	latest.current = groups;

	const move = useCallback(
		(issue: Issue, status: IssueStatus, index: number): boolean => {
			const group = latest.current.find((candidate) => candidate.status === status);
			const patch = group ? planMove(group.issues, issue, status, index) : null;
			return patch !== null && update(issue, patch);
		},
		[update],
	);

	useEffect(
		() =>
			monitorForElements({
				canMonitor: ({ source }) => draggedIssueId(source.data) !== null,
				onDrop: ({ source, location }) => {
					const issueId = draggedIssueId(source.data);
					const innermost = location.current.dropTargets[0];
					if (!issueId || !innermost) return;
					const target = parseDropTarget(innermost.data);
					if (!target) return;
					const groups = latest.current;
					const issue = groups.flatMap((group) => group.issues).find(({ id }) => id === issueId);
					if (!issue) return;

					if (target.target === "group") {
						const group = groups.find((candidate) => candidate.status === target.status);
						const size = group?.issues.filter(({ id }) => id !== issueId).length ?? 0;
						move(issue, target.status, target.at === "start" ? 0 : size);
						return;
					}
					// Look the target up now rather than trusting the data it registered with, since
					// its status may have changed while the drag was in progress.
					const group = groups.find((candidate) =>
						candidate.issues.some(({ id }) => id === target.issueId),
					);
					if (!group) return;
					const others = group.issues.filter(({ id }) => id !== issueId);
					const index = others.findIndex(({ id }) => id === target.issueId);
					// The issue was dropped on itself.
					if (index === -1) return;
					const edge = extractClosestEdge(innermost.data);
					move(issue, group.status, edge === "bottom" ? index + 1 : index);
				},
			}),
		[move],
	);

	return move;
}
