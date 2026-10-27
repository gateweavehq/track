import type { Issue, IssueStatus } from "@tangent/protocol";
import { ChevronRight, Plus } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { useHotkeys } from "#/lib/hotkeys";
import { groupByStatus } from "#/lib/issues";
import { useMembersById, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { type IssueField, IssueRow } from "./issue-row";
import { STATUS_META, StatusIcon } from "./meta";

/**
 * Issues grouped by status, driven from the keyboard: J/K or the arrow keys move the selection,
 * Enter opens the issue, and S, P and A change the selected issue's status, priority and
 * assignee.
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
	const actions = useWorkspaceActions();
	const teams = useTeamsById();
	const members = useMembersById();
	const groups = useMemo(
		() => groupByStatus(issues).filter((group) => group.issues.length > 0),
		[issues],
	);
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

	function move(step: 1 | -1) {
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

	const next = () => move(1);
	const previous = () => move(-1);
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
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
				const label = STATUS_META[group.status].label;
				const header = (
					<h2
						key={`group-${group.status}`}
						className="sticky top-12 z-20 flex h-9 items-center gap-2 border-b bg-muted/80 px-3 backdrop-blur sm:px-4"
					>
						<button
							type="button"
							onClick={() => toggle(group.status)}
							aria-expanded={!isCollapsed}
							className="flex min-w-0 flex-1 items-center gap-2 text-sm"
						>
							<ChevronRight
								className={cn(
									"size-3.5 text-muted-foreground transition-transform",
									!isCollapsed && "rotate-90",
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
