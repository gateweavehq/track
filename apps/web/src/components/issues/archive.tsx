import type {
	ActiveIssue,
	ArchivedIssue,
	Issue,
	SyncedIssue,
	Team,
} from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	Bot,
	ChevronRight,
	CloudOff,
	Gauge,
	Layers,
	ListTree,
} from "lucide-react";
import type { ReactNode } from "react";
import { CycleIcon } from "#/components/cycles/meta";
import { useReadOnView } from "#/components/inbox/hooks";
import { Markdown } from "#/components/markdown";
import { MemberAvatar } from "#/components/members/member-avatar";
import { ProjectStatusIcon } from "#/components/projects/meta";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { actorName } from "#/lib/actors";
import { useIssueDetails } from "#/lib/archived";
import { monthsLabel } from "#/lib/automations";
import { cycleName, stateIn } from "#/lib/cycles";
import { formatDateTime, formatDay, formatRelative } from "#/lib/dates";
import { estimateLabel, issueKey } from "#/lib/issues";
import { send } from "#/lib/mutations";
import {
	useArchivedIssues,
	useCycle,
	useIssueById,
	useIssueStatus,
	useMembersById,
	useProject,
	useStatuses,
	useTeamsById,
} from "#/lib/queries";
import { statusOf } from "#/lib/statuses";
import { ArchivedActivity } from "./issue-activity";
import { LabelChips } from "./labels";
import { PRIORITY_META, PriorityIcon, StatusIcon } from "./meta";
import { ProposalItem } from "./proposal-item";
import { PullRequestList } from "./pull-requests";

/** Archives or restores an issue. Asking for what the issue already is changes nothing. */
function useArchive() {
	const client = useSyncClient();
	return (issue: SyncedIssue, archived: boolean) =>
		send(client, { name: "issue.archive", args: { id: issue.id, archived } });
}

/**
 * The issue page's archive button: archives a completed or canceled issue, and is not there for
 * an open one, which is never archived. An archived issue has a page of its own.
 */
export function ArchiveIssueButton({ issue, closed }: { issue: ActiveIssue; closed: boolean }) {
	const archive = useArchive();
	if (!closed) return null;
	return (
		<Button
			variant="ghost"
			size="icon"
			className="size-8"
			aria-label="Archive issue"
			title="Archive issue"
			onClick={() => archive(issue, true)}
		>
			<Archive />
		</Button>
	);
}

/**
 * An archived issue's page. The replica keeps only a slim row of it (`ArchivedIssue`): what lists,
 * links, search and progress need. While there is a connection the page asks the server for the
 * rest (description, labels, comments, history, proposals and pull requests) and shows it
 * read-only, without putting it in the replica. Offline it shows what the replica has, and says
 * so. Restoring the issue brings the whole of it back to edit.
 */
export function ArchivedIssueDetail({ issue, team }: { issue: ArchivedIssue; team: Team }) {
	const { slug } = useWorkspace();
	const archive = useArchive();
	const status = useIssueStatus(issue);
	const project = useProject(issue.projectId ?? "");
	const cycle = useCycle(issue.cycleId ?? "");
	const parent = useIssueById(issue.parentId);
	const teams = useTeamsById();
	const key = issueKey(team, issue);
	const parentKey = parent ? issueKey(teams.get(parent.teamId), parent) : null;
	const full = useIssueDetails(slug, issue.id, issue);
	const details = full.status === "loaded" ? full.details : null;
	useReadOnView(issue.id);

	return (
		<div className="flex min-h-full flex-col">
			<header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-4 text-sm">
				<Link
					to="/$workspace/team/$teamKey"
					params={{ workspace: slug, teamKey: team.key }}
					className="text-muted-foreground hover:text-foreground"
				>
					{team.name}
				</Link>
				<ChevronRight className="size-4 text-muted-foreground" />
				<Link
					to="/$workspace/team/$teamKey/archive"
					params={{ workspace: slug, teamKey: team.key }}
					className="text-muted-foreground hover:text-foreground"
				>
					Archive
				</Link>
				<ChevronRight className="size-4 text-muted-foreground" />
				<span className="font-mono text-xs">{key}</span>
			</header>

			<article className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8 lg:px-12">
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
						. Lists and boards leave it out; search and progress still count it.
					</p>
					<Button variant="outline" size="sm" onClick={() => archive(issue, false)}>
						<ArchiveRestore />
						Restore
					</Button>
				</div>

				{parent && parentKey && (
					<Link
						to="/$workspace/issue/$issueKey"
						params={{ workspace: slug, issueKey: parentKey }}
						className="flex w-fit max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
					>
						<ListTree className="size-4 shrink-0" />
						{/* The spaces keep the words apart in the link's accessible name. */}
						<span className="shrink-0">Sub-issue of </span>
						<span className="shrink-0 font-mono text-xs">{parentKey} </span>
						<span className="truncate">{parent.title}</span>
					</Link>
				)}
				<h1 className="text-2xl font-semibold tracking-tight break-words">{issue.title}</h1>
				{details?.issue.description && <Markdown source={details.issue.description} />}

				<dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
					<Field label="Status">
						<StatusIcon status={status} />
						{status.name}
					</Field>
					{details && <WholeFields issue={details.issue} />}
					<Field label="Project">
						{project ? (
							<>
								<ProjectStatusIcon status={project.status} />
								<span className="truncate">{project.name}</span>
							</>
						) : (
							<>
								<Layers className="size-4 text-muted-foreground" />
								<span className="text-muted-foreground">No project</span>
							</>
						)}
					</Field>
					{cycle && (
						<Field label="Cycle">
							<CycleIcon state={stateIn(cycle, team, Date.now())} />
							<span className="truncate">{cycleName(cycle)}</span>
						</Field>
					)}
					<Field label="Estimate">
						<Gauge className="size-4 text-muted-foreground" />
						{issue.estimate === null ? (
							<span className="text-muted-foreground">No estimate</span>
						) : (
							estimateLabel(issue.estimate)
						)}
					</Field>
					{details && <DateFields issue={details.issue} />}
				</dl>

				{details ? (
					<>
						<PullRequestList issueId={issue.id} pullRequests={details.pullRequests} />
						{details.proposals.length > 0 && (
							<section
								aria-labelledby="proposals-heading"
								className="space-y-3 rounded-lg border bg-muted/40 p-3"
							>
								<h2
									id="proposals-heading"
									className="flex items-center gap-1.5 text-sm font-medium"
								>
									<Bot aria-hidden className="size-4 text-muted-foreground" />
									Proposed by agents
								</h2>
								<ul className="space-y-2">
									{details.proposals.map((proposal) => (
										<ProposalItem key={proposal.id} proposal={proposal} readOnly />
									))}
								</ul>
							</section>
						)}
						<ArchivedActivity
							issue={details.issue}
							activity={details.activities}
							comments={details.comments}
						/>
						<p className="text-sm text-muted-foreground">
							An archived issue cannot be changed. Restore it to edit it or to comment.
						</p>
					</>
				) : full.status === "loading" ? (
					<p aria-busy className="text-sm text-muted-foreground">
						Loading the rest of the issue…
					</p>
				) : (
					<div className="flex gap-3 rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
						<CloudOff className="mt-0.5 size-4 shrink-0" />
						{full.status === "failed" ? (
							<div className="space-y-2">
								<p>
									The rest of this issue could not be loaded from the server. Its description,
									labels, comments and history are still kept there.
								</p>
								<Button variant="outline" size="sm" onClick={full.retry}>
									Try again
								</Button>
							</div>
						) : (
							<p>
								This browser keeps only an archived issue&rsquo;s title, status and links. Its
								description, labels, comments and history are kept on the server, and show here when
								you are online. Restore the issue to see and edit all of it.
							</p>
						)}
					</div>
				)}
			</article>
		</div>
	);
}

/** What only the server's copy of an archived issue has: priority, assignee and labels. */
function WholeFields({ issue }: { issue: Issue }) {
	const members = useMembersById();
	const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined;
	return (
		<>
			<Field label="Priority">
				<PriorityIcon priority={issue.priority} />
				{PRIORITY_META[issue.priority].label}
			</Field>
			<Field label="Assignee">
				<MemberAvatar member={assignee} className="size-4" />
				{issue.assigneeId ? (
					actorName(issue.assigneeId, members)
				) : (
					<span className="text-muted-foreground">Unassigned</span>
				)}
			</Field>
			<Field label="Labels">
				{issue.labelIds.length > 0 ? (
					<LabelChips labelIds={issue.labelIds} className="flex-wrap" />
				) : (
					<span className="text-muted-foreground">No labels</span>
				)}
			</Field>
		</>
	);
}

/** The server's copy's dates, and who made the issue. */
function DateFields({ issue }: { issue: Issue }) {
	const members = useMembersById();
	return (
		<>
			{issue.startDate && <Field label="Start date">{formatDay(issue.startDate)}</Field>}
			{issue.dueDate && <Field label="Due date">{formatDay(issue.dueDate)}</Field>}
			<Field label="Created">
				<span title={formatDateTime(issue.createdAt)}>
					{formatRelative(issue.createdAt)} by {actorName(issue.creatorId, members)}
				</span>
			</Field>
		</>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="py-1 text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 items-center gap-2 py-1">{children}</dd>
		</>
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
					{team.archiveAfterMonths === null
						? "Archive a completed or canceled issue from its page to take it out of lists and boards."
						: `Completed and canceled issues come here after ${monthsLabel(team.archiveAfterMonths)} untouched, or when someone archives one from its page.`}
				</Notice>
			) : (
				<ul aria-label={`${team.name} archive`} className="divide-y">
					{issues.map((issue) => {
						const key = issueKey(team, issue);
						const status = statusOf(statuses, issue);
						const { archivedAt } = issue;
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
