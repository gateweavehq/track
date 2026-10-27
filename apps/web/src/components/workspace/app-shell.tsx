import { deleteIdbReplicas } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	ChevronDown,
	Inbox,
	Keyboard,
	LogOut,
	Menu,
	Plus,
	Search,
	Settings,
	SquarePen,
	UserPlus,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { useMembersById, useTeams } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { isAdmin, useMyRole, useWorkspace, useWorkspaceActions } from "./context";
import { SyncBadge } from "./sync-status";

export function AppShell({ children }: { children: ReactNode }) {
	const { name } = useWorkspace();
	const [menuOpen, setMenuOpen] = useState(false);
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	// On small screens the sidebar is an overlay; close it once the user has gone somewhere.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation by design.
	useEffect(() => setMenuOpen(false), [pathname]);

	return (
		<div className="flex h-dvh overflow-hidden">
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
	);
}

const navLink =
	"flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/80 hover:bg-accent hover:text-foreground";
const activeNavLink = "bg-accent font-medium text-foreground";

function Sidebar() {
	const { slug, userId } = useWorkspace();
	const actions = useWorkspaceActions();
	const teams = useTeams();
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
					to="/$workspace/my-issues"
					params={{ workspace: slug }}
					className={navLink}
					activeProps={{ className: activeNavLink }}
				>
					<Inbox className="size-4" />
					My issues
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

			<nav aria-label="Teams" className="mt-6 min-h-0 flex-1 overflow-y-auto px-2">
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
								activeProps={{ className: activeNavLink }}
							>
								<span className="w-9 shrink-0 font-mono text-xs text-muted-foreground">
									{team.key}
								</span>
								<span className="truncate">{team.name}</span>
							</Link>
						</li>
					))}
				</ul>
			</nav>

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
		await deleteIdbReplicas().catch(() => {});
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
