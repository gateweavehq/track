import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	Bookmark,
	Bot,
	ChevronDown,
	CircleUserRound,
	Inbox,
	IterationCcw,
	Keyboard,
	Layers,
	Lock,
	LogOut,
	Menu,
	Plus,
	Search,
	Settings,
	SquarePen,
	UserPlus,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useUnreadInboxCount } from "#/components/inbox/hooks";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Kbd } from "#/components/ui/kbd";
import { authClient } from "#/lib/auth-client";
import { MOD_LABEL } from "#/lib/hotkeys";
import { useMembersById, useProposalCount, useSavedViews, useTeams } from "#/lib/queries";
import { forgetEverything } from "#/lib/replica";
import { cn } from "#/lib/utils";
import { isAdmin, useMyRole, useWorkspace, useWorkspaceActions } from "./context";
import { DemoBanner } from "./demo-banner";
import { SyncBadge } from "./sync-status";

export function AppShell({ children }: { children: ReactNode }) {
	const { name, demo } = useWorkspace();
	const [menuOpen, setMenuOpen] = useState(false);
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	// On small screens the sidebar is an overlay; close it once the user has gone somewhere.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation by design.
	useEffect(() => setMenuOpen(false), [pathname]);

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			{demo && <DemoBanner />}
			<div className="flex min-h-0 flex-1">
				{menuOpen && (
					<button
						type="button"
						aria-label="Close menu"
						className="fixed inset-0 z-30 bg-black/40 md:hidden"
						onClick={() => setMenuOpen(false)}
					/>
				)}
				<aside
					className={cn(
						"fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r bg-background transition-transform md:static md:w-60 md:translate-x-0",
						menuOpen ? "translate-x-0" : "-translate-x-full",
					)}
				>
					<Sidebar />
				</aside>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:hidden">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Open menu"
							onClick={() => setMenuOpen(true)}
						>
							<Menu />
						</Button>
						<span className="truncate text-sm font-medium">{name}</span>
					</div>
					<main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
				</div>
			</div>
		</div>
	);
}

const navLink =
	"flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/80 hover:bg-accent hover:text-foreground";
const activeNavLink = "bg-accent font-medium text-foreground";

function Sidebar() {
	const { slug, userId } = useWorkspace();
	const actions = useWorkspaceActions();
	const teams = useTeams();
	const views = useSavedViews(userId);
	const proposalCount = useProposalCount();
	const unread = useUnreadInboxCount();
	const me = useMembersById().get(userId);
	const admin = isAdmin(useMyRole());

	return (
		<>
			<div className="p-2">
				<WorkspaceMenu />
			</div>
			<div className="space-y-0.5 px-2">
				<button
					type="button"
					className={cn(navLink, "w-full")}
					onClick={actions.openCommandPalette}
				>
					<Search className="size-4" />
					Search
					<span className="ml-auto flex gap-0.5">
						<Kbd>{MOD_LABEL}</Kbd>
						<Kbd>K</Kbd>
					</span>
				</button>
				<button
					type="button"
					className={cn(navLink, "w-full")}
					onClick={() => actions.createIssue()}
				>
					<SquarePen className="size-4" />
					New issue
					<Kbd className="ml-auto">C</Kbd>
				</button>
				<Link
					to="/$workspace/inbox"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
					aria-label={unread > 0 ? `Inbox, ${unread} unread` : undefined}
				>
					<Inbox className="size-4" />
					Inbox
					{unread > 0 && (
						<span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
							{unread}
						</span>
					)}
				</Link>
				<Link
					to="/$workspace/my-issues"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<CircleUserRound className="size-4" />
					My issues
				</Link>
				<Link
					to="/$workspace/projects"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Layers className="size-4" />
					Projects
				</Link>
				<Link
					to="/$workspace/proposals"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Bot className="size-4" />
					Proposals
					{proposalCount > 0 && (
						<span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
							{proposalCount}
						</span>
					)}
				</Link>
				<Link
					to="/$workspace/settings"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Settings className="size-4" />
					Settings
				</Link>
			</div>

			<div className="mt-6 min-h-0 flex-1 space-y-6 overflow-y-auto px-2">
				{views.length > 0 && (
					<nav aria-label="Views">
						<h2 className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
							Views
						</h2>
						<ul className="space-y-0.5">
							{views.map((view) => (
								<li key={view.id}>
									<Link
										to="/$workspace/view/$viewId"
										params={{ workspace: slug, viewId: view.id }}
										className={navLink}
										activeProps={{ className: activeNavLink }}
									>
										<Bookmark className="size-4 shrink-0 text-muted-foreground" />
										<span className="truncate">{view.name}</span>
										{view.ownerId !== null && (
											<Lock
												role="img"
												aria-label="Personal"
												className="ml-auto size-3 shrink-0 text-muted-foreground"
											/>
										)}
									</Link>
								</li>
							))}
						</ul>
					</nav>
				)}
				<nav aria-label="Teams">
					<div className="flex h-7 items-center justify-between px-2">
						<h2 className="text-xs font-medium text-muted-foreground">Teams</h2>
						{admin && (
							<Button
								variant="ghost"
								size="icon"
								className="size-6"
								aria-label="Create team"
								onClick={actions.createTeam}
							>
								<Plus />
							</Button>
						)}
					</div>
					<ul className="space-y-0.5">
						{teams.map((team) => (
							<li key={team.id}>
								<Link
									to="/$workspace/team/$teamKey"
									params={{ workspace: slug, teamKey: team.key }}
									className={navLink}
									// Not lit on the team's cycles page, whose own link is.
									activeOptions={{ exact: true }}
									activeProps={{ className: activeNavLink }}
								>
									<span className="w-9 shrink-0 font-mono text-xs text-muted-foreground">
										{team.key}
									</span>
									<span className="truncate">{team.name}</span>
								</Link>
								{team.cycles && (
									<Link
										to="/$workspace/team/$teamKey/cycles"
										params={{ workspace: slug, teamKey: team.key }}
										className={cn(navLink, "pl-13")}
										activeProps={{ className: activeNavLink }}
										aria-label={`${team.name} cycles`}
									>
										<IterationCcw className="size-4 text-muted-foreground" />
										Cycles
									</Link>
								)}
							</li>
						))}
					</ul>
				</nav>
			</div>

			<div className="flex items-center gap-2 border-t p-3">
				<MemberAvatar member={me} className="size-6" />
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm">{me?.name ?? "You"}</p>
					<SyncBadge />
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="Keyboard shortcuts"
					onClick={actions.showShortcuts}
				>
					<Keyboard />
				</Button>
			</div>
		</>
	);
}

function WorkspaceMenu() {
	const { name, slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const client = useSyncClient();
	const navigate = useNavigate();

	async function signOut() {
		// Close the replica first so its storage can be deleted.
		await client.close();
		await authClient.signOut();
		// Workspace replicas are cached per user; leave nothing behind on a shared device.
		await forgetEverything();
		await navigate({ to: "/login" });
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-accent"
				>
					<span className="flex size-5 items-center justify-center rounded bg-primary text-[11px] text-primary-foreground">
						{name.slice(0, 1).toUpperCase()}
					</span>
					<span className="truncate">{name}</span>
					<ChevronDown className="ml-auto size-4 text-muted-foreground" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuLabel className="truncate text-xs text-muted-foreground">
					{name}
				</DropdownMenuLabel>
				{admin && (
					<DropdownMenuItem asChild>
						<Link
							to="/$workspace/settings/members"
							params={{ workspace: slug }}
							search={{ invite: true }}
						>
							<UserPlus />
							Invite people
						</Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuItem asChild>
					<Link to="/$workspace/settings" params={{ workspace: slug }}>
						<Settings />
						Settings
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link to="/">
						<ArrowLeftRight />
						Switch workspace
					</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void signOut()}>
					<LogOut />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
