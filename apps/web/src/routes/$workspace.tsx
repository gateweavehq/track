import { ISSUE_STATUSES, type Issue, type IssueStatus, type Team } from "@tangent/protocol";
import {
	createBrowserSyncClient,
	type SyncClient,
	type SyncState,
	uuidv7,
} from "@tangent/sync-client";
import {
	SyncProvider,
	shallowEqual,
	useQuery,
	useSyncClient,
	useSyncStatus,
} from "@tangent/sync-client/react";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { generateKeyBetween } from "fractional-indexing";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { getSession } from "#/lib/session";
import { getWorkspace } from "#/lib/workspace";

// A minimal live view of a workspace until the issue UI lands. It runs entirely on the sync
// client: data comes from IndexedDB first, edits apply instantly, and changes stream in live.
export const Route = createFileRoute("/$workspace")({
	ssr: false,
	beforeLoad: async () => {
		if (!(await getSession())) throw redirect({ to: "/login" });
	},
	loader: async ({ params }) => {
		const workspace = await getWorkspace({ data: params.workspace });
		if (!workspace) throw notFound();
		return workspace;
	},
	component: WorkspacePage,
});

function WorkspacePage() {
	const { workspace: slug } = Route.useParams();
	const { id, userId } = Route.useLoaderData();
	const client = useWorkspaceClient(slug, id, userId);

	return (
		<main className="mx-auto max-w-2xl space-y-8 p-6 pt-16">
			{client && (
				<SyncProvider client={client}>
					<header className="flex items-end justify-between">
						<div className="space-y-1">
							<Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
								← Workspaces
							</Link>
							<h1 className="text-xl font-semibold tracking-tight">/{slug}</h1>
						</div>
						<SyncBadge />
					</header>
					<WorkspaceContent />
				</SyncProvider>
			)}
		</main>
	);
}

function useWorkspaceClient(slug: string, workspaceId: string, userId: string) {
	const [client, setClient] = useState<SyncClient | null>(null);
	useEffect(() => {
		const next = createBrowserSyncClient({
			workspace: slug,
			// Keyed by ids, so a renamed workspace keeps its local data.
			storageKey: `${userId}:${workspaceId}`,
			userId,
			onReject: (error) => toast.error("Your change was not saved", { description: error.message }),
		});
		setClient(next);
		return () => {
			void next.close();
		};
	}, [slug, workspaceId, userId]);
	return client;
}

const BADGES = {
	live: ["Live", "bg-emerald-500"],
	connecting: ["Connecting", "bg-amber-500"],
	offline: ["Offline", "bg-amber-500"],
	outdated: ["Update available", "bg-red-500"],
	unauthorized: ["Signed out", "bg-red-500"],
	forbidden: ["No access", "bg-red-500"],
} as const;

function SyncBadge() {
	const { connection, pending } = useSyncStatus();
	const [label, color] = BADGES[connection];
	return (
		<p className="flex items-center gap-2 text-sm text-muted-foreground">
			<span className={`size-2 rounded-full ${color}`} />
			{label}
			{pending > 0 && <span>· {pending} unsynced</span>}
		</p>
	);
}

const selectTeams = (state: SyncState) =>
	[...state.teams.values()].sort((a, b) => a.key.localeCompare(b.key));

const selectIssues = (state: SyncState) =>
	[...state.issues.values()].sort((a, b) =>
		a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : a.id.localeCompare(b.id),
	);

function WorkspaceContent() {
	const { connection, loaded } = useSyncStatus();
	const teams = useQuery(selectTeams, shallowEqual);
	const issues = useQuery(selectIssues, shallowEqual);

	if (connection === "outdated") {
		return (
			<Notice message="A new version of Tangent is available.">
				<Button onClick={() => window.location.reload()}>Reload</Button>
			</Notice>
		);
	}
	if (connection === "unauthorized") {
		return (
			<Notice message="Your session has ended.">
				<Button asChild>
					<Link to="/login">Sign in</Link>
				</Button>
			</Notice>
		);
	}
	if (connection === "forbidden") {
		return <Notice message="You no longer have access to this workspace." />;
	}
	if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;

	return (
		<div className="space-y-8">
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Teams</h2>
				{teams.length > 0 ? (
					<ul className="flex flex-wrap gap-2 text-sm">
						{teams.map((team) => (
							<li key={team.id} className="rounded-md border px-2 py-1">
								<span className="font-medium">{team.key}</span>{" "}
								<span className="text-muted-foreground">{team.name}</span>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">No teams yet.</p>
				)}
				<CreateTeam />
			</section>

			{teams.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-sm font-medium">Issues</h2>
					<CreateIssue teams={teams} last={issues.at(-1)} />
					{issues.length > 0 ? (
						<ul className="divide-y rounded-lg border">
							{issues.map((issue) => (
								<IssueRow key={issue.id} issue={issue} teams={teams} />
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">No issues yet.</p>
					)}
				</section>
			)}
		</div>
	);
}

function Notice({ message, children }: { message: string; children?: ReactNode }) {
	return (
		<div className="space-y-4 rounded-lg border p-6 text-sm">
			<p>{message}</p>
			{children}
		</div>
	);
}

function CreateTeam() {
	const client = useSyncClient();
	const [key, setKey] = useState("");
	const [name, setName] = useState("");

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		try {
			void client.mutate({ name: "team.create", args: { id: uuidv7(), key, name } });
			setKey("");
			setName("");
		} catch {
			toast.error("Use 1-7 uppercase letters or digits for the key, starting with a letter.");
		}
	}

	return (
		<form onSubmit={onSubmit} className="flex gap-2">
			<Input
				value={key}
				onChange={(event) => setKey(event.target.value.toUpperCase())}
				placeholder="ENG"
				className="w-24"
				aria-label="Team key"
				required
			/>
			<Input
				value={name}
				onChange={(event) => setName(event.target.value)}
				placeholder="Engineering"
				aria-label="Team name"
				required
			/>
			<Button type="submit" variant="secondary">
				Add team
			</Button>
		</form>
	);
}

function CreateIssue({ teams, last }: { teams: Team[]; last: Issue | undefined }) {
	const client = useSyncClient();
	const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const team = teams.find((t) => t.id === teamId) ?? teams[0];

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!team) return;
		void client.mutate({
			name: "issue.create",
			args: {
				id: uuidv7(),
				teamId: team.id,
				title,
				sortOrder: generateKeyBetween(last?.sortOrder ?? null, null),
			},
		});
		setTitle("");
	}

	return (
		<form onSubmit={onSubmit} className="flex gap-2">
			<select
				value={team?.id}
				onChange={(event) => setTeamId(event.target.value)}
				className="h-9 rounded-md border bg-transparent px-2 text-sm"
				aria-label="Team"
			>
				{teams.map((t) => (
					<option key={t.id} value={t.id}>
						{t.key}
					</option>
				))}
			</select>
			<Input
				value={title}
				onChange={(event) => setTitle(event.target.value)}
				placeholder="What needs doing?"
				aria-label="Issue title"
				required
			/>
			<Button type="submit">Add issue</Button>
		</form>
	);
}

function IssueRow({ issue, teams }: { issue: Issue; teams: Team[] }) {
	const client = useSyncClient();
	const team = teams.find((t) => t.id === issue.teamId);

	return (
		<li className="flex items-center gap-3 px-4 py-2 text-sm">
			<span className="w-16 shrink-0 tabular-nums text-muted-foreground">
				{team?.key}-{issue.number}
			</span>
			<span className="flex-1 truncate">{issue.title}</span>
			<select
				value={issue.status}
				onChange={(event) =>
					void client.mutate({
						name: "issue.update",
						args: {
							id: issue.id,
							baseVersion: issue.version,
							patch: { status: event.target.value as IssueStatus },
						},
					})
				}
				className="h-8 rounded-md border bg-transparent px-2 text-xs"
				aria-label="Status"
			>
				{ISSUE_STATUSES.map((status) => (
					<option key={status} value={status}>
						{status.replace("_", " ")}
					</option>
				))}
			</select>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => void client.mutate({ name: "issue.delete", args: { id: issue.id } })}
			>
				Delete
			</Button>
		</li>
	);
}
