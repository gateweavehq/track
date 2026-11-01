import type { Issue, Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { issueKey } from "#/lib/issues";
import { send } from "#/lib/mutations";
import { useArchivedIssues, useStatuses } from "#/lib/queries";
import { statusOf } from "#/lib/statuses";
import { StatusIcon } from "./meta";

/** Archives or restores an issue. Asking for what the issue already is changes nothing. */
function useArchive() {
	const client = useSyncClient();
	return (issue: Issue, archived: boolean) =>
		send(client, { name: "issue.archive", args: { id: issue.id, archived } });
}

/**
 * The issue page's archive button: archives a completed or canceled issue, restores an archived
 * one, and is not there for an open issue, which is never archived.
 */
export function ArchiveIssueButton({ issue, closed }: { issue: Issue; closed: boolean }) {
	const archive = useArchive();
	if (issue.archivedAt === null && !closed) return null;
	const archived = issue.archivedAt !== null;
	return (
		<Button
			variant="ghost"
			size="icon"
			className="size-8"
			aria-label={archived ? "Restore issue" : "Archive issue"}
			title={archived ? "Restore issue" : "Archive issue"}
			onClick={() => archive(issue, !archived)}
		>
			{archived ? <ArchiveRestore /> : <Archive />}
		</Button>
	);
}

/** Says an issue is archived, and what that means, with a way to restore it. */
export function ArchivedNotice({ issue }: { issue: Issue }) {
	const archive = useArchive();
	if (issue.archivedAt === null) return null;
	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
		>
			<Archive className="size-4 shrink-0 text-muted-foreground" />
			<p className="min-w-0 flex-1 text-muted-foreground">
				Archived{" "}
				<time
					dateTime={new Date(issue.archivedAt).toISOString()}
					title={formatDateTime(issue.archivedAt)}
				>
					{formatRelative(issue.archivedAt)}
				</time>
				. Lists and boards leave it out; search and progress still count it. Reopening it restores
				it.
			</p>
			<Button variant="outline" size="sm" onClick={() => archive(issue, false)}>
				Restore
			</Button>
		</div>
	);
}

/** A team's archived issues, the latest archived first, each with a way to restore it. */
export function TeamArchive({ team }: { team: Team }) {
	const { slug } = useWorkspace();
	const issues = useArchivedIssues(team.id);
	const statuses = useStatuses();
	const archive = useArchive();

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<Link
					to="/$workspace/team/$teamKey"
					params={{ workspace: slug, teamKey: team.key }}
					className="truncate text-sm text-muted-foreground hover:text-foreground"
				>
					{team.name}
				</Link>
				<span className="text-sm text-muted-foreground">/</span>
				<h1 className="text-sm font-medium">Archive</h1>
				<span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>
			</header>
			{issues.length === 0 ? (
				<Notice title="Nothing archived">
					Archive a completed or canceled issue from its page to take it out of lists and boards.
				</Notice>
			) : (
				<ul aria-label={`${team.name} archive`} className="divide-y">
					{issues.map((issue) => {
						const key = issueKey(team, issue);
						const status = statusOf(statuses, issue);
						const archivedAt = issue.archivedAt ?? issue.updatedAt;
						return (
							<li key={issue.id} className="flex items-center gap-3 px-3 py-2 text-sm sm:px-4">
								<StatusIcon status={status} />
								<Link
									to="/$workspace/issue/$issueKey"
									params={{ workspace: slug, issueKey: key }}
									className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
								>
									<span className="shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
									<span className="truncate">{issue.title}</span>
								</Link>
								<span
									className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
									title={formatDateTime(archivedAt)}
								>
									Archived {formatRelative(archivedAt)}
								</span>
								<Button
									variant="ghost"
									size="sm"
									aria-label={`Restore ${key}`}
									onClick={() => archive(issue, false)}
								>
									<ArchiveRestore />
									<span className="hidden sm:inline">Restore</span>
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
