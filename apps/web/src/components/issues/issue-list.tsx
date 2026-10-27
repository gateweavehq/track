import type { Issue, IssueStatus } from "@tangent/protocol";
import { ChevronRight, Plus } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { useHotkeys } from "#/lib/hotkeys";
import { groupByStatus, type StatusGroup } from "#/lib/issues";
import { useMembersById, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { useIssueDropZone, useIssueMoves } from "./dnd";
import { type IssueField, IssueRow } from "./issue-row";
import { STATUS_META, StatusIcon } from "./meta";

/**
 * Issues grouped by status, driven from the keyboard: J/K or the arrow keys move the selection,
 * Enter opens the issue, S, P and A change the selected issue's status, priority and assignee,
 * and Alt with the arrow keys moves it up or down. Rows can also be dragged.
 */
export function IssueList({
	issues,
	defaults,
	empty,
}: {
	issues: Issue[];
	/** Values for issues created from this list, such as its team. */
	defaults: IssueDefaults;
	/** Shown when there are no issues at all. */
	empty: ReactNode;
}) {
	const teams = useTeamsById();
	const members = useMembersById();
	const allGroups = useMemo(() => groupByStatus(issues), [issues]);
	const groups = allGroups.filter((group) => group.issues.length > 0);
	const moveIssue = useIssueMoves(allGroups);
	const [collapsed, setCollapsed] = useState<ReadonlySet<IssueStatus>>(() => new Set());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ issueId: string; field: IssueField } | null>(null);
	const rows = useRef(new Map<string, HTMLAnchorElement>());

	const visible = groups.flatMap((group) => (collapsed.has(group.status) ? [] : group.issues));

	const registerRow = useCallback((issueId: string, link: HTMLAnchorElement | null) => {
		if (link) rows.current.set(issueId, link);
		else rows.current.delete(issueId);
	}, []);
	const onMenuChange = useCallback((issueId: string, field: IssueField | null) => {
		setMenu(field ? { issueId, field } : null);
	}, []);

	function select(step: 1 | -1) {
		const index = visible.findIndex((issue) => issue.id === selectedId);
		const next =
			index === -1 ? visible[step === 1 ? 0 : visible.length - 1] : visible[index + step];
		// Focusing the row selects it (onFocus) and scrolls it into view.
		if (next) rows.current.get(next.id)?.focus();
	}

	function openMenu(field: IssueField) {
		if (selectedId && visible.some((issue) => issue.id === selectedId)) {
			setMenu({ issueId: selectedId, field });
		}
	}

	function moveSelected(step: 1 | -1) {
		const group = groups.find((candidate) =>
			candidate.issues.some((issue) => issue.id === selectedId),
		);
		const index = group?.issues.findIndex((issue) => issue.id === selectedId) ?? -1;
		const issue = group?.issues[index];
		if (!group || !issue || collapsed.has(group.status)) return;
		// Positions count the other issues, so one step up is index - 1 and one down is index + 1.
		if (moveIssue(issue, group.status, index + step)) {
			// Reordering moves the row's element, which drops its focus.
			requestAnimationFrame(() => rows.current.get(issue.id)?.focus());
		}
	}

	const next = () => select(1);
	const previous = () => select(-1);
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
		"alt+ArrowDown": () => moveSelected(1),
		"alt+ArrowUp": () => moveSelected(-1),
		s: () => openMenu("status"),
		p: () => openMenu("priority"),
		a: () => openMenu("assignee"),
	});

	function toggle(status: IssueStatus) {
		setCollapsed((current) => {
			const next = new Set(current);
			if (!next.delete(status)) next.add(status);
			return next;
		});
	}

	if (groups.length === 0) return empty;

	// Headers and rows are siblings in one flat list, so a row that changes status moves to its
	// new group without remounting and keeps focus and any open menu.
	return (
		<div>
			{groups.flatMap((group) => {
				const isCollapsed = collapsed.has(group.status);
				const header = (
					<GroupHeader
						key={`group-${group.status}`}
						group={group}
						collapsed={isCollapsed}
						onToggle={toggle}
						defaults={defaults}
					/>
				);
				if (isCollapsed) return [header];
				return [
					header,
					...group.issues.map((issue) => (
						<IssueRow
							key={issue.id}
							issue={issue}
							team={teams.get(issue.teamId)}
							assignee={issue.assigneeId ? members.get(issue.assigneeId) : undefined}
							selected={issue.id === selectedId}
							menu={menu?.issueId === issue.id ? menu.field : null}
							onMenuChange={onMenuChange}
							onSelect={setSelectedId}
							registerRow={registerRow}
						/>
					)),
				];
			})}
		</div>
	);
}

/** A status group's header. Dropping an issue on it moves the issue to the top of the group. */
function GroupHeader({
	group,
	collapsed,
	onToggle,
	defaults,
}: {
	group: StatusGroup;
	collapsed: boolean;
	onToggle: (status: IssueStatus) => void;
	defaults: IssueDefaults;
}) {
	const actions = useWorkspaceActions();
	const [ref, over] = useIssueDropZone<HTMLHeadingElement>(group.status, "start");
	const label = STATUS_META[group.status].label;

	return (
		<h2
			ref={ref}
			className={cn(
				"sticky top-12 z-20 flex h-9 items-center gap-2 border-b bg-muted/80 px-3 backdrop-blur sm:px-4",
				over && "bg-accent",
			)}
		>
			<button
				type="button"
				onClick={() => onToggle(group.status)}
				aria-expanded={!collapsed}
				className="flex min-w-0 flex-1 items-center gap-2 text-sm"
			>
				<ChevronRight
					className={cn(
						"size-3.5 text-muted-foreground transition-transform",
						!collapsed && "rotate-90",
					)}
				/>
				<StatusIcon status={group.status} />
				<span className="font-medium">{label}</span>
				<span className="text-muted-foreground tabular-nums">{group.issues.length}</span>
			</button>
			<Button
				variant="ghost"
				size="icon"
				className="size-7"
				aria-label={`Create a ${label} issue`}
				onClick={() => actions.createIssue({ ...defaults, status: group.status })}
			>
				<Plus />
			</Button>
		</h2>
	);
}
