import {
	type ActiveIssue,
	type ArchivedIssue,
	type Issue,
	isActiveIssue,
} from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { Archive, Plus } from "lucide-react";
import { useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { issueKey, sortOrderAfter } from "#/lib/issues";
import { send, useUpdateIssue } from "#/lib/mutations";
import { projectProgress } from "#/lib/projects";
import {
	useIssueStatus,
	useMembersById,
	useStatuses,
	useSubIssues,
	useTeamsById,
} from "#/lib/queries";
import { RowButton } from "./issue-row";
import { IssueStatusIcon, StatusIcon } from "./meta";
import { StatusPicker } from "./pickers";
import { DueDate } from "./schedule";

/**
 * An issue's sub-issues with their progress, and a field to add one: in the parent's team, at the
 * end of the manual order. Sub-issues are ordinary issues, so they also show on their team's list.
 */
export function SubIssues({ issue }: { issue: Issue }) {
	const client = useSyncClient();
	const subIssues = useSubIssues(issue.id);
	const [adding, setAdding] = useState(false);
	const [title, setTitle] = useState("");
	const progress = projectProgress(subIssues, useStatuses());

	function create() {
		const text = title.trim();
		if (!text) return;
		const sent = send(client, {
			name: "issue.create",
			args: {
				id: uuidv7(),
				teamId: issue.teamId,
				title: text,
				parentId: issue.id,
				sortOrder: sortOrderAfter(client.getState().activeIssues.values()),
			},
		});
		// The field stays open for the next one.
		if (sent) setTitle("");
	}

	function close() {
		setTitle("");
		setAdding(false);
	}

	if (subIssues.length === 0 && !adding) {
		return (
			<Button
				variant="ghost"
				size="sm"
				className="-ml-2 text-muted-foreground"
				onClick={() => setAdding(true)}
			>
				<Plus />
				Add sub-issue
			</Button>
		);
	}

	return (
		<section aria-labelledby="sub-issues-heading" className="space-y-2">
			<div className="flex items-center gap-2">
				<h2 id="sub-issues-heading" className="text-sm font-medium">
					Sub-issues
				</h2>
				{subIssues.length > 0 && (
					<span
						className="text-xs text-muted-foreground tabular-nums"
						title="Done, out of all that are not canceled"
					>
						{progress.done}/{progress.total}
					</span>
				)}
				<Button
					variant="ghost"
					size="icon"
					className="ml-auto size-7"
					aria-label="Add sub-issue"
					onClick={() => setAdding(true)}
				>
					<Plus />
				</Button>
			</div>
			{subIssues.length > 0 && (
				<ul className="rounded-lg border">
					{subIssues.map((subIssue) =>
						isActiveIssue(subIssue) ? (
							<SubIssueRow key={subIssue.id} issue={subIssue} />
						) : (
							<ArchivedSubIssueRow key={subIssue.id} issue={subIssue} />
						),
					)}
				</ul>
			)}
			{adding && (
				<input
					// biome-ignore lint/a11y/noAutofocus: opened by the user to type a title at once
					autoFocus
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							create();
						} else if (event.key === "Escape") {
							event.stopPropagation();
							close();
						}
					}}
					onBlur={() => {
						if (!title.trim()) close();
					}}
					placeholder="Sub-issue title, then Enter"
					aria-label="New sub-issue title"
					maxLength={512}
					className="h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
				/>
			)}
		</section>
	);
}

/** An archived sub-issue: its slim row has its status, key and title, and nothing to edit. */
function ArchivedSubIssueRow({ issue }: { issue: ArchivedIssue }) {
	const { slug } = useWorkspace();
	const team = useTeamsById().get(issue.teamId);
	const key = issueKey(team, issue);

	return (
		<li className="relative flex h-9 items-center gap-2 border-b px-2 text-sm text-muted-foreground last:border-b-0 hover:bg-accent/40">
			<span className="flex size-7 shrink-0 items-center justify-center">
				<IssueStatusIcon issue={issue} />
			</span>
			<span aria-hidden className="w-16 shrink-0 font-mono text-xs">
				{key}
			</span>
			<Link
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: key }}
				className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				<span className="sr-only">{key} </span>
				{issue.title}
			</Link>
			<span className="flex shrink-0 items-center gap-1 text-xs">
				<Archive aria-hidden className="size-3.5" />
				Archived
			</span>
		</li>
	);
}

function SubIssueRow({ issue }: { issue: ActiveIssue }) {
	const { slug } = useWorkspace();
	const update = useUpdateIssue();
	const issueStatus = useIssueStatus(issue);
	const team = useTeamsById().get(issue.teamId);
	const members = useMembersById();
	const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined;
	const key = issueKey(team, issue);

	return (
		<li className="relative flex h-9 items-center gap-2 border-b px-2 text-sm last:border-b-0 hover:bg-accent/40">
			<StatusPicker
				teamId={issue.teamId}
				value={issue.status}
				onChange={(status) => update(issue, { status })}
			>
				<RowButton label={`Status: ${issueStatus.name}`}>
					<StatusIcon status={issueStatus} />
				</RowButton>
			</StatusPicker>
			<span aria-hidden className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
				{key}
			</span>
			<Link
				to="/$workspace/issue/$issueKey"
				params={{ workspace: slug, issueKey: key }}
				className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				<span className="sr-only">{key} </span>
				{issue.title}
			</Link>
			<DueDate issue={issue} />
			{assignee && <MemberAvatar member={assignee} className="size-5" />}
		</li>
	);
}
