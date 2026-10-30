import type { Issue } from "@gateweave/track-protocol";
import {
	CalendarClock,
	Columns3,
	type LucideIcon,
	Plus,
	Rows3,
	Search,
	Tag,
	X,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { MOD_LABEL, useHotkeys } from "#/lib/hotkeys";
import {
	DUE_FILTER_LABELS,
	DUE_FILTERS,
	type DueFilter,
	issueKey,
	matchesDue,
	matchesQuery,
} from "#/lib/issues";
import { useLabelsById, useMembersById, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import type { IssueView } from "#/lib/views";
import { useDragAutoScroll } from "./dnd";
import { IssueBoard } from "./issue-board";
import { IssueList } from "./issue-list";
import { LabelChips, LabelMenu } from "./labels";

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
	labelFilter,
	onLabelFilterChange,
	dueFilter,
	onDueFilterChange,
	intro,
}: {
	title: string;
	badge?: ReactNode;
	/** Shown between the header and the issues, such as a project's details. */
	intro?: ReactNode;
	issues: Issue[];
	defaults: IssueDefaults;
	empty: ReactNode;
	view: IssueView;
	onViewChange: (view: IssueView) => void;
	/** Show only issues with any of these labels. Ids that do not resolve are ignored. */
	labelFilter: readonly string[] | undefined;
	onLabelFilterChange: (labelIds: string[]) => void;
	dueFilter: DueFilter | undefined;
	onDueFilterChange: (due: DueFilter | undefined) => void;
}) {
	const actions = useWorkspaceActions();
	const teams = useTeamsById();
	const members = useMembersById();
	const labels = useLabelsById();
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

	// A shared link can name labels deleted since, or labels of another workspace.
	const activeLabels = useMemo(
		() => [...new Set(labelFilter)].filter((id) => labels.has(id)),
		[labelFilter, labels],
	);

	const filtered = useMemo(() => {
		const wanted = new Set(activeLabels);
		const text = deferredQuery.trim();
		if (!text && wanted.size === 0 && !dueFilter) return issues;
		const now = new Date();
		return issues.filter(
			(issue) =>
				(wanted.size === 0 || issue.labelIds.some((id) => wanted.has(id))) &&
				(!dueFilter || matchesDue(issue, dueFilter, now)) &&
				(!text ||
					matchesQuery(
						text,
						issueKey(teams.get(issue.teamId), issue),
						issue.title,
						(issue.assigneeId && members.get(issue.assigneeId)?.name) || "",
					)),
		);
	}, [issues, deferredQuery, activeLabels, dueFilter, teams, members]);

	const text = query.trim();
	const emptyState =
		text || activeLabels.length > 0 || dueFilter ? (
			<Notice
				title="No matching issues"
				action={
					<Button
						variant="outline"
						onClick={() => {
							setQuery("");
							onLabelFilterChange([]);
							onDueFilterChange(undefined);
						}}
					>
						Clear filters
					</Button>
				}
			>
				{text
					? `Nothing here matches “${text}” with these filters.`
					: "Nothing here matches these filters."}
			</Notice>
		) : (
			empty
		);

	return (
		<div ref={pageRef} className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">{title}</h1>
				{badge}
				<span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>
				<div className="ml-auto flex items-center gap-1.5 sm:gap-2">
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
							className="h-8 w-20 rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring sm:w-32 lg:w-56"
						/>
					</div>
					<LabelFilter value={activeLabels} onChange={onLabelFilterChange} />
					<DueDateFilter value={dueFilter} onChange={onDueFilterChange} />
					<ViewSwitch view={view} onChange={onViewChange} />
					<Button size="sm" onClick={() => actions.createIssue(defaults)}>
						<Plus />
						<span className="hidden sm:inline">New issue</span>
					</Button>
				</div>
			</header>
			{intro}
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

function LabelFilter({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
	const labels = useLabelsById();
	const names = value.map((id) => labels.get(id)?.name).join(", ");
	return (
		<div className="flex items-center">
			<LabelMenu
				selected={value}
				placeholder="Filter by label…"
				onToggle={(id) =>
					onChange(value.includes(id) ? value.filter((other) => other !== id) : [...value, id])
				}
			>
				<Button
					variant="outline"
					size="sm"
					className={cn("h-8 gap-1.5 px-2", value.length > 0 && "rounded-r-none border-r-0")}
					aria-label={value.length > 0 ? `Labels: ${names}` : "Filter by label"}
					title={value.length > 0 ? `Issues with any of: ${names}` : "Filter by label"}
				>
					<Tag className="size-3.5" />
					{value.length > 0 ? (
						<>
							<span className="tabular-nums lg:hidden">{value.length}</span>
							<LabelChips labelIds={value} max={2} className="hidden lg:flex" />
						</>
					) : (
						<span className="hidden lg:inline">Labels</span>
					)}
				</Button>
			</LabelMenu>
			{value.length > 0 && (
				<Button
					variant="outline"
					size="icon"
					className="size-8 rounded-l-none"
					aria-label="Clear the label filter"
					onClick={() => onChange([])}
				>
					<X />
				</Button>
			)}
		</div>
	);
}

function DueDateFilter({
	value,
	onChange,
}: {
	value: DueFilter | undefined;
	onChange: (due: DueFilter | undefined) => void;
}) {
	const label = value ? DUE_FILTER_LABELS[value] : "Filter by due date";
	return (
		<div className="flex items-center">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className={cn("h-8 gap-1.5 px-2", value && "rounded-r-none border-r-0")}
						aria-label={value ? `Due date: ${label}` : label}
						title={label}
					>
						<CalendarClock className="size-3.5" />
						<span className="hidden lg:inline">{value ? label : "Due"}</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuRadioGroup
						value={value ?? ""}
						onValueChange={(next) => onChange(DUE_FILTERS.find((due) => due === next))}
					>
						{DUE_FILTERS.map((due) => (
							<DropdownMenuRadioItem key={due} value={due}>
								{DUE_FILTER_LABELS[due]}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{value && (
				<Button
					variant="outline"
					size="icon"
					className="size-8 rounded-l-none"
					aria-label="Clear the due date filter"
					onClick={() => onChange(undefined)}
				>
					<X />
				</Button>
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
