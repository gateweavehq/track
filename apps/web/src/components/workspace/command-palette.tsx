import type { Issue } from "@gateweave/track-protocol";
import type { SyncState } from "@gateweave/track-sync-client";
import { shallowEqual, useQuery } from "@gateweave/track-sync-client/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	Bot,
	Download,
	Inbox,
	IterationCcw,
	Keyboard,
	Layers,
	type LucideIcon,
	Settings,
	SquarePen,
	UserPlus,
	Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { StatusIcon } from "#/components/issues/meta";
import { ProjectStatusIcon } from "#/components/projects/meta";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "#/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog";
import { MOD_LABEL } from "#/lib/hotkeys";
import { issueKey, matchesQuery, parseIssueKey } from "#/lib/issues";
import { useUpdateIssue } from "#/lib/mutations";
import { useProjectList, useTeams, useTeamsById } from "#/lib/queries";
import { search } from "#/lib/search";
import { useExportIssues } from "#/lib/use-export";
import { isAdmin, useMyRole, useWorkspace, useWorkspaceActions } from "./context";

interface PaletteCommand {
	id: string;
	label: string;
	icon: LucideIcon;
	shortcut?: string;
	keywords?: string[];
	run: () => void;
}

const selectRecentIssues = (state: SyncState) =>
	[...state.issues.values()].sort((a, b) => b.updatedAt - a.updatedAt);

const MAX_RECENT = 5;

const selectState = (state: SyncState) => state;

function findIssue(state: SyncState, teamKey: string, number: number): Issue | undefined {
	for (const team of state.teams.values()) {
		if (team.key !== teamKey) continue;
		for (const issue of state.issues.values()) {
			if (issue.teamId === team.id && issue.number === number) return issue;
		}
	}
	return undefined;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const actions = useWorkspaceActions();
	const teams = useTeams();
	const teamsById = useTeamsById();
	const issues = useQuery(selectRecentIssues, shallowEqual);
	const state = useQuery(selectState);
	const [query, setQuery] = useState("");
	// "Set project…" turns the palette into a list of projects for the issue on screen.
	const [mode, setMode] = useState<"commands" | "project">("commands");
	const projects = useProjectList();
	const updateIssue = useUpdateIssue();
	const params = useParams({ strict: false });
	const admin = isAdmin(useMyRole());
	const exportIssues = useExportIssues();

	const parsedKey = parseIssueKey(params.issueKey ?? "");
	const screenIssue = parsedKey ? findIssue(state, parsedKey.teamKey, parsedKey.number) : undefined;

	const commands: PaletteCommand[] = [
		{
			id: "create-issue",
			label: "Create issue",
			icon: SquarePen,
			shortcut: "C",
			keywords: ["new"],
			run: () => actions.createIssue(),
		},
		{
			id: "create-project",
			label: "Create project",
			icon: Layers,
			keywords: ["new"],
			run: actions.createProject,
		},
		...(screenIssue
			? [
					{
						id: "set-project",
						label: "Set project…",
						icon: Layers,
						keywords: ["move", "add", "issue"],
						run: () => setMode("project"),
					},
				]
			: []),
		...(admin
			? [
					{
						id: "create-team",
						label: "Create team",
						icon: Users,
						keywords: ["new"],
						run: actions.createTeam,
					},
					{
						id: "invite",
						label: "Invite people",
						icon: UserPlus,
						keywords: ["member", "add", "team"],
						run: () =>
							void navigate({
								to: "/$workspace/settings/members",
								params: { workspace: slug },
								search: { invite: true },
							}),
					},
				]
			: []),
		{
			id: "my-issues",
			label: "Go to My issues",
			icon: Inbox,
			keywords: ["assigned"],
			run: () => void navigate({ to: "/$workspace/my-issues", params: { workspace: slug } }),
		},
		{
			id: "projects",
			label: "Go to projects",
			icon: Layers,
			keywords: ["goals"],
			run: () => void navigate({ to: "/$workspace/projects", params: { workspace: slug } }),
		},
		{
			id: "proposals",
			label: "Go to Proposals",
			icon: Bot,
			keywords: ["agents", "review", "accept", "dismiss"],
			run: () => void navigate({ to: "/$workspace/proposals", params: { workspace: slug } }),
		},
		...teams.map((team) => ({
			id: `team-${team.id}`,
			label: `Go to ${team.name}`,
			icon: Users,
			keywords: [team.key],
			run: () =>
				void navigate({
					to: "/$workspace/team/$teamKey",
					params: { workspace: slug, teamKey: team.key },
				}),
		})),
		...teams
			.filter((team) => team.cycles !== null)
			.map((team) => ({
				id: `cycles-${team.id}`,
				label: `Go to ${team.name} cycles`,
				icon: IterationCcw,
				keywords: [team.key, "sprint"],
				run: () =>
					void navigate({
						to: "/$workspace/team/$teamKey/cycles",
						params: { workspace: slug, teamKey: team.key },
					}),
			})),
		{
			id: "members",
			label: "Go to Members",
			icon: Users,
			keywords: ["settings", "people", "roles"],
			run: () => void navigate({ to: "/$workspace/settings/members", params: { workspace: slug } }),
		},
		{
			id: "teams-settings",
			label: "Go to Team settings",
			icon: Settings,
			keywords: ["settings", "rename", "key"],
			run: () => void navigate({ to: "/$workspace/settings/teams", params: { workspace: slug } }),
		},
		{
			id: "export-csv",
			label: "Export issues as CSV",
			icon: Download,
			keywords: ["download", "backup", "spreadsheet"],
			run: () => exportIssues("csv"),
		},
		{
			id: "export-json",
			label: "Export issues as JSON",
			icon: Download,
			keywords: ["download", "backup"],
			run: () => exportIssues("json"),
		},
		{
			id: "switch-workspace",
			label: "Switch workspace",
			icon: ArrowLeftRight,
			run: () => void navigate({ to: "/" }),
		},
		{
			id: "shortcuts",
			label: "Keyboard shortcuts",
			icon: Keyboard,
			shortcut: "?",
			keywords: ["help", "keys"],
			run: actions.showShortcuts,
		},
	];

	const matchingCommands = commands.filter((command) =>
		matchesQuery(query, command.label, ...(command.keywords ?? [])),
	);
	const keyOf = (issue: Issue) => issueKey(teamsById.get(issue.teamId), issue);
	const searching = query.trim() !== "";
	const found = useMemo(() => (searching ? search(state, query) : []), [state, query, searching]);
	const matchingIssues: { issue: Issue; snippet?: string }[] = searching
		? found
		: issues.slice(0, MAX_RECENT).map((issue) => ({ issue }));

	const projectChoices = [{ id: null, name: "No project", status: null }, ...projects].filter(
		(choice) => matchesQuery(query, choice.name),
	);

	function chooseProject() {
		setQuery("");
		setMode("project");
	}

	function run(action: () => void) {
		onClose();
		action();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="top-[15%] max-w-xl translate-y-0 overflow-hidden p-0 [&>button:last-child]:hidden">
				<DialogTitle className="sr-only">Command palette</DialogTitle>
				<DialogDescription className="sr-only">
					Search issues by identifier, title, description or comments, or run a command.
				</DialogDescription>
				{/* Without vim bindings, so Ctrl+K reaches the shortcut that closes the palette. */}
				<Command shouldFilter={false} loop vimBindings={false}>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={mode === "project" ? "Set project…" : "Search issues or type a command…"}
						className="h-12"
					/>
					<CommandList className="max-h-96">
						<CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
						{mode === "project" && screenIssue && (
							<CommandGroup heading={`Set project for ${keyOf(screenIssue)}`}>
								{projectChoices.map((choice) => (
									<CommandItem
										key={choice.id ?? "none"}
										value={`project-${choice.id ?? "none"}`}
										onSelect={() => run(() => updateIssue(screenIssue, { projectId: choice.id }))}
									>
										{choice.status ? (
											<ProjectStatusIcon status={choice.status} />
										) : (
											<Layers className="size-4 text-muted-foreground" />
										)}
										<span className="truncate">{choice.name}</span>
										{choice.id === screenIssue.projectId && (
											<CommandShortcut>current</CommandShortcut>
										)}
									</CommandItem>
								))}
							</CommandGroup>
						)}
						{mode === "commands" && matchingIssues.length > 0 && (
							<CommandGroup heading={searching ? "Issues" : "Recently updated"}>
								{matchingIssues.map(({ issue, snippet }) => {
									const key = keyOf(issue);
									return (
										<CommandItem
											key={issue.id}
											value={`issue-${issue.id}`}
											onSelect={() =>
												run(
													() =>
														void navigate({
															to: "/$workspace/issue/$issueKey",
															params: { workspace: slug, issueKey: key },
														}),
												)
											}
										>
											<StatusIcon status={issue.status} />
											<span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
												{key}
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate">{issue.title}</span>
												{snippet && (
													<span className="block truncate text-xs text-muted-foreground">
														{snippet}
													</span>
												)}
											</span>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
						{mode === "commands" && matchingCommands.length > 0 && (
							<CommandGroup heading="Commands">
								{matchingCommands.map((command) => (
									<CommandItem
										key={command.id}
										value={command.id}
										onSelect={() =>
											command.id === "set-project" ? chooseProject() : run(command.run)
										}
									>
										<command.icon className="size-4 text-muted-foreground" />
										{command.label}
										{command.shortcut && <CommandShortcut>{command.shortcut}</CommandShortcut>}
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
					<div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
						<span>↑↓ to move</span>
						<span>Enter to select</span>
						<span>{MOD_LABEL} K to close</span>
					</div>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
