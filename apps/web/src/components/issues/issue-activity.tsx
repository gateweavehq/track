import type { Activity, ActivityChange, Comment, Issue, Label } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import {
	CalendarClock,
	CalendarDays,
	CircleUserRound,
	Ellipsis,
	FileText,
	Gauge,
	Layers,
	type LucideIcon,
	Pencil,
	Plus,
	Tag,
	UserRound,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Kbd } from "#/components/ui/kbd";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatDay, formatRelative } from "#/lib/dates";
import { MOD_LABEL } from "#/lib/hotkeys";
import { estimateLabel } from "#/lib/issues";
import { send } from "#/lib/mutations";
import {
	useIssueActivity,
	useIssueComments,
	useLabelsById,
	useMembersById,
	useProjectsById,
} from "#/lib/queries";
import { LabelChip } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";

type Entry =
	| { kind: "created"; key: string; at: number; actorId: string }
	| { kind: "activity"; key: string; at: number; activity: Activity }
	| { kind: "comment"; key: string; at: number; comment: Comment };

/** History and comments in one timeline, oldest first, starting with the issue's creation. */
function timeline(issue: Issue, activity: Activity[], comments: Comment[]): Entry[] {
	const entries: Entry[] = [
		...activity.map((a) => ({
			kind: "activity" as const,
			key: a.id,
			at: a.createdAt,
			activity: a,
		})),
		...comments.map((c) => ({ kind: "comment" as const, key: c.id, at: c.createdAt, comment: c })),
	];
	entries.sort((a, b) => a.at - b.at);
	return [
		{ kind: "created", key: "created", at: issue.createdAt, actorId: issue.creatorId },
		...entries,
	];
}

export function IssueActivity({ issue }: { issue: Issue }) {
	const activity = useIssueActivity(issue.id);
	const comments = useIssueComments(issue.id);
	const entries = useMemo(() => timeline(issue, activity, comments), [issue, activity, comments]);

	return (
		<section aria-labelledby="activity-heading" className="space-y-4 border-t pt-6">
			<h2 id="activity-heading" className="text-sm font-medium">
				Activity
			</h2>
			<ol className="space-y-3">
				{entries.map((entry) => (
					<li key={entry.key}>
						{entry.kind === "comment" ? (
							<CommentItem comment={entry.comment} />
						) : (
							<HistoryItem
								actorId={entry.kind === "created" ? entry.actorId : entry.activity.actorId}
								change={entry.kind === "created" ? null : entry.activity.change}
								proposedBy={entry.kind === "created" ? null : entry.activity.proposedBy}
								at={entry.at}
							/>
						)}
					</li>
				))}
			</ol>
			<CommentComposer issueId={issue.id} />
		</section>
	);
}

/** One line of history. A null change is the issue's creation. */
function HistoryItem({
	actorId,
	change,
	proposedBy,
	at,
}: {
	actorId: string;
	change: ActivityChange | null;
	/** The agent whose proposal the actor accepted. */
	proposedBy: string | null;
	at: number;
}) {
	const members = useMembersById();
	const labels = useLabelsById();
	const projects = useProjectsById();
	const name = (id: string | null) => (id ? (members.get(id)?.name ?? "Someone") : "nobody");
	const projectName = (id: string | null) =>
		id ? (projects.get(id)?.name ?? "a deleted project") : "no project";
	const { icon, text } = describe(change, actorId, name, labels, projectName);

	return (
		<div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
			<span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
			<p className="min-w-0 flex-1 leading-5">
				<span className="font-medium text-foreground">{name(actorId)}</span> {text}
				{proposedBy && <>, as {name(proposedBy)} proposed</>}
				<span aria-hidden> · </span>
				<time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
					{formatRelative(at)}
				</time>
			</p>
		</div>
	);
}

function describe(
	change: ActivityChange | null,
	actorId: string,
	name: (id: string | null) => string,
	labels: ReadonlyMap<string, Label>,
	projectName: (id: string | null) => string,
): { icon: ReactNode; text: ReactNode } {
	const plain = (Icon: LucideIcon, text: ReactNode) => ({
		icon: <Icon className="size-3.5" />,
		text,
	});
	if (!change) return plain(Plus, "created the issue");

	switch (change.type) {
		case "status":
			return {
				icon: <StatusIcon status={change.to} className="size-3.5" />,
				text: (
					<>
						changed the status from {STATUS_META[change.from].label} to{" "}
						<Strong>{STATUS_META[change.to].label}</Strong>
					</>
				),
			};
		case "priority": {
			const icon = <PriorityIcon priority={change.to} className="size-3.5" />;
			if (change.to === 0) return { icon, text: "removed the priority" };
			const to = <Strong>{PRIORITY_META[change.to].label}</Strong>;
			if (change.from === 0) return { icon, text: <>set the priority to {to}</> };
			return {
				icon,
				text: (
					<>
						changed the priority from {PRIORITY_META[change.from].label} to {to}
					</>
				),
			};
		}
		case "assignee":
			if (change.to === null) {
				return plain(UserRound, <>unassigned {name(change.from)}</>);
			}
			if (change.to === actorId && change.from === null) {
				return plain(UserRound, "assigned the issue to themselves");
			}
			return plain(
				UserRound,
				change.from === null ? (
					<>
						assigned <Strong>{name(change.to)}</Strong>
					</>
				) : (
					<>
						reassigned the issue from {name(change.from)} to <Strong>{name(change.to)}</Strong>
					</>
				),
			);
		case "project":
			if (change.to === null) {
				return plain(Layers, <>removed the issue from {projectName(change.from)}</>);
			}
			return plain(
				Layers,
				change.from === null ? (
					<>
						added the issue to <Strong>{projectName(change.to)}</Strong>
					</>
				) : (
					<>
						moved the issue from {projectName(change.from)} to{" "}
						<Strong>{projectName(change.to)}</Strong>
					</>
				),
			);
		case "title":
			return plain(
				Pencil,
				<>
					renamed the issue to <Strong title={`Was “${change.from}”`}>“{change.to}”</Strong>
				</>,
			);
		case "description":
			return plain(FileText, "updated the description");
		case "label": {
			const found = labels.get(change.labelId);
			const chip = found ? <LabelChip label={found} /> : "a deleted label";
			return plain(
				Tag,
				<span className="inline-flex flex-wrap items-center gap-1 align-middle">
					{change.added ? "added" : "removed"} {chip}
				</span>,
			);
		}
		case "startDate":
			return plain(CalendarDays, dateText("start date", change.from, change.to));
		case "dueDate":
			return plain(CalendarClock, dateText("due date", change.from, change.to));
		case "estimate":
			if (change.to === null) return plain(Gauge, "removed the estimate");
			return plain(
				Gauge,
				change.from === null ? (
					<>
						estimated the issue at <Strong>{estimateLabel(change.to)}</Strong>
					</>
				) : (
					<>
						changed the estimate from {estimateLabel(change.from)} to{" "}
						<Strong>{estimateLabel(change.to)}</Strong>
					</>
				),
			);
	}
}

function dateText(field: string, from: string | null, to: string | null): ReactNode {
	if (to === null) return `removed the ${field}`;
	if (from === null) {
		return (
			<>
				set the {field} to <Strong>{formatDay(to)}</Strong>
			</>
		);
	}
	return (
		<>
			changed the {field} from {formatDay(from)} to <Strong>{formatDay(to)}</Strong>
		</>
	);
}

function Strong({ children, title }: { children: ReactNode; title?: string }) {
	return (
		<span className="font-medium text-foreground" title={title}>
			{children}
		</span>
	);
}

function CommentItem({ comment }: { comment: Comment }) {
	const client = useSyncClient();
	const { userId } = useWorkspace();
	const role = useMyRole();
	const author = useMembersById().get(comment.authorId);
	const [editing, setEditing] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const mine = comment.authorId === userId;
	const canDelete = mine || isAdmin(role);
	const name = author?.name ?? "Someone";

	return (
		<article
			aria-label={`Comment by ${name}`}
			className="rounded-lg border bg-card px-3 py-2.5 text-card-foreground"
		>
			<header className="flex items-center gap-2 text-xs">
				{author ? (
					<MemberAvatar member={author} className="size-5" />
				) : (
					<CircleUserRound aria-hidden className="size-5 text-muted-foreground" />
				)}
				<span className="font-medium">{name}</span>
				<time
					dateTime={new Date(comment.createdAt).toISOString()}
					title={formatDateTime(comment.createdAt)}
					className="text-muted-foreground"
				>
					{formatRelative(comment.createdAt)}
				</time>
				{comment.updatedAt > comment.createdAt && (
					<span className="text-muted-foreground" title={formatDateTime(comment.updatedAt)}>
						(edited)
					</span>
				)}
				{canDelete && !editing && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="ml-auto size-6"
								aria-label={`More for the comment by ${name}`}
							>
								<Ellipsis />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{mine && <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>}
							{canDelete && (
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onSelect={() => setConfirmDelete(true)}
								>
									Delete
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</header>
			{editing ? (
				<CommentForm
					initial={comment.body}
					submitLabel="Save"
					label="Edit comment"
					autoFocus
					onCancel={() => setEditing(false)}
					onSubmit={(body) => {
						if (body !== comment.body) {
							send(client, { name: "comment.update", args: { id: comment.id, body } });
						}
						setEditing(false);
						return true;
					}}
				/>
			) : (
				<p className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
					{comment.body}
				</p>
			)}
			{confirmDelete && (
				<ConfirmDialog
					title="Delete comment?"
					confirmLabel="Delete comment"
					onConfirm={() => {
						send(client, { name: "comment.delete", args: { id: comment.id } });
					}}
					onClose={() => setConfirmDelete(false)}
				>
					It will be deleted for everyone in the workspace.
				</ConfirmDialog>
			)}
		</article>
	);
}

function CommentComposer({ issueId }: { issueId: string }) {
	const client = useSyncClient();
	return (
		<CommentForm
			submitLabel="Comment"
			label="Comment"
			placeholder="Leave a comment…"
			onSubmit={(body) =>
				send(client, { name: "comment.create", args: { id: uuidv7(), issueId, body } })
			}
		/>
	);
}

/** A comment's text box. `onSubmit` gets trimmed text and returns whether to clear the box. */
function CommentForm({
	initial = "",
	submitLabel,
	label,
	placeholder,
	autoFocus,
	onSubmit,
	onCancel,
}: {
	initial?: string;
	submitLabel: string;
	label: string;
	placeholder?: string;
	autoFocus?: boolean;
	onSubmit: (body: string) => boolean;
	onCancel?: () => void;
}) {
	const [body, setBody] = useState(initial);
	const empty = !body.trim();

	function submit() {
		if (!empty && onSubmit(body.trim())) setBody("");
	}

	return (
		<form
			className="mt-2 space-y-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<Textarea
				value={body}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						submit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						if (onCancel) onCancel();
						else event.currentTarget.blur();
					}
				}}
				aria-label={label}
				placeholder={placeholder}
				autoFocus={autoFocus}
				maxLength={100_000}
				className="field-sizing-content min-h-20 resize-none"
			/>
			<div className="flex items-center justify-end gap-2">
				<span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
					<Kbd>{MOD_LABEL}</Kbd>
					<Kbd>Enter</Kbd>
				</span>
				{onCancel && (
					<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				)}
				<Button type="submit" size="sm" disabled={empty}>
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}
