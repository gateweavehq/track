import { ISSUE_STATUSES, type IssueFilterKey, type IssueFilters } from "@gateweave/track-protocol";
import {
	Boxes,
	CalendarClock,
	Check,
	ChevronRight,
	CircleDashed,
	CircleUserRound,
	ListFilter,
	type LucideIcon,
	SignalHigh,
	Tag,
	Users,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { compactFilters, type FiltersUpdate, isPicked, toggleFilter } from "#/lib/filters";
import { DUE_FILTER_LABELS, DUE_FILTERS } from "#/lib/issues";
import {
	useActiveMembers,
	useLabels,
	useLabelsById,
	useMembersById,
	useProjectList,
	useProjectsById,
	useTeams,
	useTeamsById,
} from "#/lib/queries";
import { cn } from "#/lib/utils";
import { LabelDot } from "./labels";
import { PRIORITY_META, PRIORITY_ORDER, STATUS_META } from "./meta";

/** The filters in the order the menu offers them. */
export const FILTER_KEYS = [
	"statuses",
	"priorities",
	"assigneeIds",
	"projectIds",
	"labelIds",
	"due",
	"teamIds",
] as const satisfies readonly IssueFilterKey[];

const FILTER_META: Record<IssueFilterKey, { label: string; icon: LucideIcon }> = {
	statuses: { label: "Status", icon: CircleDashed },
	priorities: { label: "Priority", icon: SignalHigh },
	assigneeIds: { label: "Assignee", icon: CircleUserRound },
	projectIds: { label: "Project", icon: Boxes },
	labelIds: { label: "Labels", icon: Tag },
	due: { label: "Due date", icon: CalendarClock },
	teamIds: { label: "Team", icon: Users },
};

interface FilterOption {
	/** Unique within its filter, for the list's keys and cmdk's values. */
	id: string;
	value: unknown;
	label: string;
	icon: ReactNode;
}

/** Every value each filter can take, as the menu lists them. */
function useFilterOptions(): Record<IssueFilterKey, FilterOption[]> {
	const members = useActiveMembers();
	const projects = useProjectList();
	const labels = useLabels();
	const teams = useTeams();
	const metaIcon = ({ icon: Icon, className }: { icon: LucideIcon; className: string }) => (
		<Icon aria-hidden className={cn("size-4", className)} />
	);
	return {
		statuses: ISSUE_STATUSES.map((status) => ({
			id: status,
			value: status,
			label: STATUS_META[status].label,
			icon: metaIcon(STATUS_META[status]),
		})),
		priorities: PRIORITY_ORDER.map((priority) => ({
			id: String(priority),
			value: priority,
			label: PRIORITY_META[priority].label,
			icon: metaIcon(PRIORITY_META[priority]),
		})),
		assigneeIds: [
			{ id: "none", value: null, label: "No assignee", icon: <MemberAvatar member={undefined} /> },
			...members.map((member) => ({
				id: member.id,
				value: member.id,
				label: member.name,
				icon: <MemberAvatar member={member} />,
			})),
		],
		projectIds: [null, ...projects].map((project) => ({
			id: project?.id ?? "none",
			value: project?.id ?? null,
			label: project?.name ?? "No project",
			icon: <Boxes aria-hidden className="size-4 text-muted-foreground" />,
		})),
		labelIds: labels.map((label) => ({
			id: label.id,
			value: label.id,
			label: label.name,
			icon: <LabelDot color={label.color} />,
		})),
		due: DUE_FILTERS.map((due) => ({
			id: due,
			value: due,
			label: DUE_FILTER_LABELS[due],
			icon: <CalendarClock aria-hidden className="size-4 text-muted-foreground" />,
		})),
		teamIds: teams.map((team) => ({
			id: team.id,
			value: team.id,
			label: team.name,
			icon: <Users aria-hidden className="size-4 text-muted-foreground" />,
		})),
	};
}

interface FilterProps {
	filters: IssueFilters;
	onChange: (update: FiltersUpdate) => void;
	/** The filters this page offers: a team's page has no team filter, for one. */
	offered: readonly IssueFilterKey[];
}

/**
 * The "Filter" button. Its menu lists the filters, then the values of the one picked, which can
 * be ticked one after another; typing searches every filter's values at once. Backspace in the
 * empty search goes back to the filters.
 */
export function FilterMenu({ filters, onChange, offered }: FilterProps) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState<IssueFilterKey | null>(null);
	const [search, setSearch] = useState("");
	const options = useFilterOptions();
	const keys = FILTER_KEYS.filter((key) => offered.includes(key));

	// The search keeps the focus, so typing goes on narrowing the list after a value is clicked and
	// after moving between the filters and their values (each step remounts the input).
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (filter !== undefined) input.current?.focus();
	}, [filter]);

	const choose = (key: IssueFilterKey | null) => {
		setFilter(key);
		setSearch("");
	};
	const valueItem = (key: IssueFilterKey, option: FilterOption, prefixed: boolean) => (
		<CommandItem
			key={`${key}:${option.id}`}
			value={`${key}:${option.id}`}
			keywords={prefixed ? [option.label, FILTER_META[key].label] : [option.label]}
			onSelect={() => onChange((current) => toggleFilter(current, key, option.value))}
		>
			{option.icon}
			<span className="truncate">
				{prefixed && <span className="text-muted-foreground">{FILTER_META[key].label}: </span>}
				{option.label}
			</span>
			{isPicked(filters, key, option.value) && <Check className="ml-auto size-4" />}
		</CommandItem>
	);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) choose(null);
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2" aria-label="Filter">
					<ListFilter className="size-3.5" />
					<span className="hidden lg:inline">Filter</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-0">
				{/* Remounted for each step, so the highlight starts at the top of the new list. */}
				<Command key={filter ?? "filters"} loop vimBindings={false}>
					<CommandInput
						ref={input}
						placeholder={filter ? `${FILTER_META[filter].label}…` : "Filter…"}
						value={search}
						onValueChange={setSearch}
						onKeyDown={(event) => {
							if (event.key === "Backspace" && search === "" && filter) {
								event.preventDefault();
								choose(null);
							}
						}}
					/>
					{/* A click picks without taking the focus from the search. */}
					<CommandList onMouseDown={(event) => event.preventDefault()}>
						<CommandEmpty>No matches</CommandEmpty>
						{filter ? (
							<CommandGroup heading={FILTER_META[filter].label}>
								{options[filter].map((option) => valueItem(filter, option, false))}
							</CommandGroup>
						) : (
							<>
								<CommandGroup>
									{keys.map((key) => {
										const Icon = FILTER_META[key].icon;
										return (
											<CommandItem
												key={key}
												value={key}
												keywords={[FILTER_META[key].label]}
												onSelect={() => choose(key)}
											>
												<Icon aria-hidden className="size-4 text-muted-foreground" />
												{FILTER_META[key].label}
												<span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
													{pickedCount(filters[key]) || null}
													<ChevronRight aria-hidden className="size-4" />
												</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
								{/* Values only once something is typed, or the list would be long. */}
								{search.trim() && (
									<CommandGroup heading="Values">
										{keys.flatMap((key) =>
											options[key].map((option) => valueItem(key, option, true)),
										)}
									</CommandGroup>
								)}
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function FilterIcon({ filter }: { filter: IssueFilterKey }) {
	const Icon = FILTER_META[filter].icon;
	return <Icon aria-hidden className="size-4 text-muted-foreground" />;
}

function pickedCount(value: IssueFilters[IssueFilterKey]): number {
	return Array.isArray(value) ? value.length : value ? 1 : 0;
}

/**
 * The filters in force, one chip each, under the page header. A chip says what it keeps and has
 * a button that removes it. `children` go at the end of the row, such as "Save view".
 */
export function ActiveFilters({
	filters,
	onChange,
	children,
}: {
	filters: IssueFilters;
	onChange: (update: FiltersUpdate) => void;
	children?: ReactNode;
}) {
	const names = useValueNames();
	const keys = FILTER_KEYS.filter((key) => filters[key] !== undefined);
	return (
		<fieldset className="flex min-w-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5 sm:px-4">
			<legend className="sr-only">Filters in force</legend>
			{keys.map((key) => {
				const description = names(key, filters);
				return (
					<span
						key={key}
						className="flex h-6 max-w-full items-center rounded-md border text-xs"
						title={`${FILTER_META[key].label}: ${description}`}
					>
						<span className="flex min-w-0 items-center gap-1.5 pl-2">
							<FilterIcon filter={key} />
							<span className="text-muted-foreground">{FILTER_META[key].label}</span>
							<span className="truncate">{description}</span>
						</span>
						<button
							type="button"
							aria-label={`Remove the ${FILTER_META[key].label.toLowerCase()} filter`}
							onClick={() =>
								onChange((current) => compactFilters({ ...current, [key]: undefined }))
							}
							className="flex h-full shrink-0 items-center rounded-r-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<X className="size-3" />
						</button>
					</span>
				);
			})}
			{keys.length > 0 && (
				<Button
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-xs text-muted-foreground"
					onClick={() => onChange(() => ({}))}
				>
					Clear
				</Button>
			)}
			{children && <div className="ml-auto flex items-center gap-1.5">{children}</div>}
		</fieldset>
	);
}

/** Names a filter's values for its chip: "Todo, In Progress". */
function useValueNames() {
	const members = useMembersById();
	const projects = useProjectsById();
	const labels = useLabelsById();
	const teams = useTeamsById();
	return (key: IssueFilterKey, filters: IssueFilters): string => {
		const list = (names: (string | undefined)[]) =>
			names.filter((name): name is string => name !== undefined).join(", ");
		switch (key) {
			// In the order the menu lists them, whatever order they were picked in.
			case "statuses":
				return list(
					ISSUE_STATUSES.filter((status) => filters.statuses?.includes(status)).map(
						(status) => STATUS_META[status].label,
					),
				);
			case "priorities":
				return list(
					PRIORITY_ORDER.filter((priority) => filters.priorities?.includes(priority)).map(
						(priority) => PRIORITY_META[priority].label,
					),
				);
			case "assigneeIds":
				return list(
					(filters.assigneeIds ?? []).map((id) =>
						id === null ? "No assignee" : members.get(id)?.name,
					),
				);
			case "projectIds":
				return list(
					(filters.projectIds ?? []).map((id) =>
						id === null ? "No project" : projects.get(id)?.name,
					),
				);
			case "labelIds":
				return list((filters.labelIds ?? []).map((id) => labels.get(id)?.name));
			case "teamIds":
				return list((filters.teamIds ?? []).map((id) => teams.get(id)?.name));
			case "due":
				return filters.due ? DUE_FILTER_LABELS[filters.due] : "";
		}
	};
}
