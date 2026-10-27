import type { Issue } from "@gateweave/track-protocol";
import { Columns3, type LucideIcon, Plus, Rows3, Search } from "lucide-react";
import { type ReactNode, useDeferredValue, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { MOD_LABEL, useHotkeys } from "#/lib/hotkeys";
import { issueKey, matchesQuery } from "#/lib/issues";
import { useMembersById, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import type { IssueView } from "#/lib/views";
import { useDragAutoScroll } from "./dnd";
import { IssueBoard } from "./issue-board";
import { IssueList } from "./issue-list";

/**
 * A page of issues: a header with a filter, the view switch and a create button, then the issues
 * as a grouped list or a board. The page is its own scroll container.
 */
export function IssuesPage({
	title,
	badge,
	issues,
	defaults,
	empty,
	view,
	onViewChange,
}: {
	title: string;
	badge?: ReactNode;
	issues: Issue[];
	defaults: IssueDefaults;
	empty: ReactNode;
	view: IssueView;
	onViewChange: (view: IssueView) => void;
}) {
	const actions = useWorkspaceActions();
	const teams = useTeamsById();
	const members = useMembersById();
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const filterRef = useRef<HTMLInputElement>(null);
	const pageRef = useRef<HTMLDivElement>(null);
	// A board scrolls inside its columns; a list scrolls the page.
	useDragAutoScroll(pageRef, view === "list");

	useHotkeys({
		"/": () => filterRef.current?.focus(),
		"mod+b": () => onViewChange(view === "list" ? "board" : "list"),
	});

	const filtered = useMemo(() => {
		if (!deferredQuery.trim()) return issues;
		return issues.filter((issue) =>
			matchesQuery(
				deferredQuery,
				issueKey(teams.get(issue.teamId), issue),
				issue.title,
				(issue.assigneeId && members.get(issue.assigneeId)?.name) || "",
			),
		);
	}, [issues, deferredQuery, teams, members]);

	const emptyState = query.trim() ? (
		<Notice title="No matching issues">Nothing here matches “{query.trim()}”.</Notice>
	) : (
		empty
	);

	return (
		<div ref={pageRef} className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">{title}</h1>
				{badge}
				<span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>
				<div className="ml-auto flex items-center gap-2">
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={filterRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									setQuery("");
									event.currentTarget.blur();
								}
							}}
							placeholder="Filter issues"
							aria-label="Filter issues"
							className="h-8 w-32 rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring sm:w-56"
						/>
					</div>
					<ViewSwitch view={view} onChange={onViewChange} />
					<Button size="sm" onClick={() => actions.createIssue(defaults)}>
						<Plus />
						<span className="hidden sm:inline">New issue</span>
					</Button>
				</div>
			</header>
			{view === "board" ? (
				<div className="min-h-0 flex-1">
					<IssueBoard issues={filtered} defaults={defaults} empty={emptyState} />
				</div>
			) : (
				<IssueList issues={filtered} defaults={defaults} empty={emptyState} />
			)}
		</div>
	);
}

const VIEW_OPTIONS: { view: IssueView; label: string; icon: LucideIcon }[] = [
	{ view: "list", label: "List", icon: Rows3 },
	{ view: "board", label: "Board", icon: Columns3 },
];

function ViewSwitch({ view, onChange }: { view: IssueView; onChange: (view: IssueView) => void }) {
	return (
		<fieldset className="flex rounded-md border p-0.5">
			<legend className="sr-only">View</legend>
			{VIEW_OPTIONS.map((option) => (
				<button
					key={option.view}
					type="button"
					aria-pressed={view === option.view}
					aria-label={option.label}
					title={`${option.label} (${MOD_LABEL} B to switch)`}
					onClick={() => onChange(option.view)}
					className={cn(
						"flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						view === option.view && "bg-accent text-foreground",
					)}
				>
					<option.icon className="size-3.5" />
				</button>
			))}
		</fieldset>
	);
}
