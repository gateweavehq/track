import type { Issue, IssueFilterKey, IssueFilters } from "@gateweave/track-protocol";
import {
	CalendarDays,
	ChartGantt,
	Columns3,
	type LucideIcon,
	Plus,
	Rows3,
	Search,
	Table2,
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
import { activeFilters, type FiltersUpdate, hasFilters, matchesFilters } from "#/lib/filters";
import { MOD_LABEL, useHotkeys } from "#/lib/hotkeys";
import { issueKey, matchesQuery } from "#/lib/issues";
import { useLabelsById, useMembersById, useProjectsById, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import type { IssueView } from "#/lib/views";
import { useDragAutoScroll } from "./dnd";
import { ActiveFilters, FilterMenu } from "./filter-menu";
import { IssueBoard } from "./issue-board";
import { IssueCalendar } from "./issue-calendar";
import { IssueList } from "./issue-list";
import { IssueTable } from "./issue-table";
import { IssueTimeline } from "./issue-timeline";

/**
 * A page of issues: a header with a text filter, the filter menu, the view switch and a create
 * button, a row of the filters in force, then the issues in the chosen layout. The page is its
 * own scroll container.
 */
export function IssuesPage({
	title,
	badge,
	issues,
	defaults,
	empty,
	view,
	onViewChange,
	filters,
	onFiltersChange,
	offeredFilters,
	filterActions,
	intro,
	scope,
}: {
	title: string;
	badge?: ReactNode;
	/** Shown between the header and the issues, such as a project's details. */
	intro?: ReactNode;
	/** What the page remembers its view and table columns by; the scope `useIssueView` takes. */
	scope: string;
	issues: Issue[];
	defaults: IssueDefaults;
	empty: ReactNode;
	view: IssueView;
	onViewChange: (view: IssueView) => void;
	/** Which issues to show. Values that no longer resolve, such as a deleted label, are ignored. */
	filters: IssueFilters;
	onFiltersChange: (update: FiltersUpdate) => void;
	/** The filters this page offers; what the page is about, such as its team, is not one. */
	offeredFilters: readonly IssueFilterKey[];
	/** Shown at the end of the row of filters in force, such as a way to save them. */
	filterActions?: ReactNode;
}) {
	const actions = useWorkspaceActions();
	const teams = useTeamsById();
	const members = useMembersById();
	const labels = useLabelsById();
	const projects = useProjectsById();
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const filterRef = useRef<HTMLInputElement>(null);
	const pageRef = useRef<HTMLDivElement>(null);
	// A board scrolls inside its columns; a list or a calendar scrolls the page.
	useDragAutoScroll(pageRef, view !== "board");

	useHotkeys({
		"/": () => filterRef.current?.focus(),
		// Toggles list and board only; from any other view it goes to the list.
		"mod+b": () => onViewChange(view === "list" ? "board" : "list"),
	});

	// A shared link or a saved view can name labels, people or projects that have gone since.
	const active = useMemo(
		() => activeFilters(filters, { teams, members, projects, labels }),
		[filters, teams, members, projects, labels],
	);
	const filtering = hasFilters(active);

	const filtered = useMemo(() => {
		const text = deferredQuery.trim();
		if (!text && !filtering) return issues;
		const now = new Date();
		return issues.filter(
			(issue) =>
				matchesFilters(issue, active, now) &&
				(!text ||
					matchesQuery(
						text,
						issueKey(teams.get(issue.teamId), issue),
						issue.title,
						(issue.assigneeId && members.get(issue.assigneeId)?.name) || "",
					)),
		);
	}, [issues, deferredQuery, active, filtering, teams, members]);

	const text = query.trim();
	const emptyState =
		text || filtering ? (
			<Notice
				title="No matching issues"
				action={
					<Button
						variant="outline"
						onClick={() => {
							setQuery("");
							onFiltersChange(() => ({}));
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
			<div className="sticky top-0 z-30 shrink-0 bg-background">
				<header className="flex h-12 items-center gap-2 border-b px-3 sm:px-4">
					<h1 className="truncate text-sm font-medium">{title}</h1>
					{badge}
					<span
						className="text-sm text-muted-foreground tabular-nums"
						title={text || filtering ? `${filtered.length} of ${issues.length} issues` : undefined}
					>
						{text || filtering ? `${filtered.length}/${issues.length}` : issues.length}
					</span>
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
								className="h-8 w-14 rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring sm:w-32 lg:w-56"
							/>
						</div>
						<FilterMenu filters={active} onChange={onFiltersChange} offered={offeredFilters} />
						<ViewSwitch view={view} onChange={onViewChange} />
						<Button size="sm" onClick={() => actions.createIssue(defaults)}>
							<Plus />
							<span className="hidden sm:inline">New issue</span>
						</Button>
					</div>
				</header>
				{(filtering || filterActions) && (
					<ActiveFilters filters={active} onChange={onFiltersChange}>
						{filterActions}
					</ActiveFilters>
				)}
			</div>
			{intro}
			{view === "board" ? (
				<div className="min-h-0 flex-1">
					<IssueBoard issues={filtered} defaults={defaults} empty={emptyState} />
				</div>
			) : view === "calendar" ? (
				<IssueCalendar issues={filtered} empty={emptyState} />
			) : view === "table" ? (
				<IssueTable key={scope} issues={filtered} empty={emptyState} scope={scope} />
			) : view === "timeline" ? (
				<IssueTimeline issues={filtered} empty={emptyState} />
			) : (
				<IssueList issues={filtered} defaults={defaults} empty={emptyState} />
			)}
		</div>
	);
}

const VIEW_OPTIONS: { view: IssueView; label: string; icon: LucideIcon }[] = [
	{ view: "list", label: "List", icon: Rows3 },
	{ view: "board", label: "Board", icon: Columns3 },
	{ view: "calendar", label: "Calendar", icon: CalendarDays },
	{ view: "table", label: "Table", icon: Table2 },
	{ view: "timeline", label: "Timeline", icon: ChartGantt },
];

/**
 * The layouts side by side, or on a phone, where five buttons crowd the header off the screen, one
 * button showing the current layout that opens a menu of them.
 */
function ViewSwitch({ view, onChange }: { view: IssueView; onChange: (view: IssueView) => void }) {
	const current = VIEW_OPTIONS.find((option) => option.view === view) ?? VIEW_OPTIONS[0];
	return (
		<>
			<fieldset className="hidden rounded-md border p-0.5 sm:flex">
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
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						className="size-8 sm:hidden"
						aria-label={`View: ${current?.label}`}
					>
						{current && <current.icon className="size-3.5" />}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuRadioGroup
						value={view}
						onValueChange={(value) => {
							const option = VIEW_OPTIONS.find((candidate) => candidate.view === value);
							if (option) onChange(option.view);
						}}
					>
						{VIEW_OPTIONS.map((option) => (
							<DropdownMenuRadioItem key={option.view} value={option.view} className="gap-2">
								<option.icon className="size-4 text-muted-foreground" />
								{option.label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
