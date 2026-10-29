import type { Issue, Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronRight, Trash } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useHotkeys } from "#/lib/hotkeys";
import { issueKey } from "#/lib/issues";
import { send, useUpdateIssue } from "#/lib/mutations";
import { useMembersById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { IssueActivity } from "./issue-activity";
import { IssueProposals } from "./issue-proposals";
import type { IssueField } from "./issue-row";
import { LabelChips, LabelPicker } from "./labels";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import { AssigneePicker, PriorityPicker, StatusPicker } from "./pickers";

export function IssueDetail({ issue, team }: { issue: Issue; team: Team }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	const update = useUpdateIssue();
	const members = useMembersById();
	const [menu, setMenu] = useState<IssueField | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const key = issueKey(team, issue);
	const assignee = issue.assigneeId ? members.get(issue.assigneeId) : undefined;
	const creator = members.get(issue.creatorId);

	function back() {
		if (canGoBack) router.history.back();
		else
			void navigate({
				to: "/$workspace/team/$teamKey",
				params: { workspace: slug, teamKey: team.key },
			});
	}

	useHotkeys({
		s: () => setMenu("status"),
		p: () => setMenu("priority"),
		a: () => setMenu("assignee"),
		l: () => setMenu("labels"),
		Escape: back,
	});

	const menuProps = (field: IssueField) => ({
		open: menu === field,
		onOpenChange: (open: boolean) => setMenu(open ? field : null),
	});

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
				<span className="font-mono text-xs">{key}</span>
				<Button
					variant="ghost"
					size="icon"
					className="ml-auto size-8"
					aria-label="Delete issue"
					onClick={() => setConfirmDelete(true)}
				>
					<Trash />
				</Button>
			</header>

			<div className="flex flex-1 flex-col lg:flex-row">
				<article className="min-w-0 space-y-4 px-6 py-8 lg:flex-1 lg:px-12">
					<TitleField issue={issue} />
					<DescriptionField issue={issue} />
					<IssueProposals issue={issue} />
					<IssueActivity issue={issue} />
				</article>

				<aside
					aria-label="Properties"
					className="shrink-0 space-y-1 border-t p-4 lg:w-72 lg:border-t-0 lg:border-l"
				>
					<Property label="Status">
						<StatusPicker
							value={issue.status}
							onChange={(status) => update(issue, { status })}
							{...menuProps("status")}
						>
							<PropertyButton>
								<StatusIcon status={issue.status} />
								{STATUS_META[issue.status].label}
							</PropertyButton>
						</StatusPicker>
					</Property>
					<Property label="Priority">
						<PriorityPicker
							value={issue.priority}
							onChange={(priority) => update(issue, { priority })}
							{...menuProps("priority")}
						>
							<PropertyButton>
								<PriorityIcon priority={issue.priority} />
								{PRIORITY_META[issue.priority].label}
							</PropertyButton>
						</PriorityPicker>
					</Property>
					<Property label="Assignee">
						<AssigneePicker
							value={issue.assigneeId}
							onChange={(assigneeId) => update(issue, { assigneeId })}
							{...menuProps("assignee")}
						>
							<PropertyButton>
								<MemberAvatar member={assignee} className="size-4" />
								{assignee?.name ?? "Unassigned"}
							</PropertyButton>
						</AssigneePicker>
					</Property>
					<Property label="Labels">
						<LabelPicker issue={issue} {...menuProps("labels")}>
							<PropertyButton className="h-auto min-h-8 py-1.5">
								{issue.labelIds.length > 0 ? (
									<LabelChips labelIds={issue.labelIds} className="flex-wrap" />
								) : (
									<span className="text-muted-foreground">Add labels</span>
								)}
							</PropertyButton>
						</LabelPicker>
					</Property>
					<dl className="space-y-2 pt-4 text-xs text-muted-foreground">
						<div className="flex justify-between gap-2 px-2">
							<dt>Created by</dt>
							<dd className="truncate text-foreground/80">{creator?.name ?? "Unknown"}</dd>
						</div>
						<div className="flex justify-between gap-2 px-2">
							<dt>Created</dt>
							<dd title={formatDateTime(issue.createdAt)}>{formatRelative(issue.createdAt)}</dd>
						</div>
						<div className="flex justify-between gap-2 px-2">
							<dt>Updated</dt>
							<dd title={formatDateTime(issue.updatedAt)}>{formatRelative(issue.updatedAt)}</dd>
						</div>
					</dl>
				</aside>
			</div>

			{confirmDelete && (
				<DeleteIssueDialog
					issue={issue}
					issueKey={key}
					onClose={() => setConfirmDelete(false)}
					onDeleted={() =>
						navigate({
							to: "/$workspace/team/$teamKey",
							params: { workspace: slug, teamKey: team.key },
							replace: true,
						})
					}
				/>
			)}
		</div>
	);
}

function Property({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-20 shrink-0 px-2 text-xs text-muted-foreground">{label}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

function PropertyButton({
	children,
	className,
	...props
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			className={cn("h-8 w-full justify-start gap-2 px-2 font-normal", className)}
			{...props}
		>
			{children}
		</Button>
	);
}

/**
 * Local text while the user edits a field, so live updates from others do not overwrite what
 * they are typing. The edit is based on the version the user started from, so the server can
 * reject it if someone else changed the same field in the meantime.
 */
function useFieldDraft(
	value: string,
	version: number,
	save: (next: string, baseVersion: number) => void,
	idleMs?: number,
) {
	const [draft, setDraftState] = useState<string | null>(null);
	// Event handlers read the draft from a ref: blur can follow a cancel before React re-renders.
	const draftRef = useRef<string | null>(null);
	const base = useRef(version);
	const latest = useRef({ value, version, save });
	latest.current = { value, version, save };

	const setDraft = (next: string | null) => {
		draftRef.current = next;
		setDraftState(next);
	};
	const flush = useCallback(() => {
		const current = draftRef.current;
		if (current !== null && current !== latest.current.value)
			latest.current.save(current, base.current);
	}, []);

	useEffect(() => {
		if (draft === null || idleMs === undefined) return;
		const timer = setTimeout(flush, idleMs);
		return () => clearTimeout(timer);
	}, [draft, idleMs, flush]);

	// Leaving the page does not blur the field, so save what was typed on the way out.
	useEffect(() => flush, [flush]);

	return {
		value: draft ?? value,
		start() {
			if (draftRef.current !== null) return;
			base.current = latest.current.version;
			setDraft(latest.current.value);
		},
		change: (next: string) => setDraft(next),
		finish() {
			flush();
			setDraft(null);
		},
		cancel: () => setDraft(null),
	};
}

function TitleField({ issue }: { issue: Issue }) {
	const update = useUpdateIssue();
	const field = useFieldDraft(issue.title, issue.version, (next, baseVersion) => {
		if (next.trim()) update(issue, { title: next.trim() }, baseVersion);
	});

	return (
		<textarea
			value={field.value}
			onFocus={field.start}
			onChange={(event) => field.change(event.target.value)}
			onBlur={field.finish}
			onKeyDown={(event) => {
				// A title is one line: Enter saves it, Escape throws the edit away.
				if (event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					field.cancel();
					event.currentTarget.blur();
				}
			}}
			aria-label="Title"
			rows={1}
			maxLength={512}
			className="field-sizing-content w-full resize-none bg-transparent text-2xl font-semibold tracking-tight outline-none"
		/>
	);
}

function DescriptionField({ issue }: { issue: Issue }) {
	const update = useUpdateIssue();
	const field = useFieldDraft(
		issue.description ?? "",
		issue.version,
		(next, baseVersion) => update(issue, { description: next.trim() ? next : null }, baseVersion),
		// Save while the user pauses, so a closed tab loses at most a moment of typing.
		1000,
	);

	return (
		<textarea
			value={field.value}
			onFocus={field.start}
			onChange={(event) => field.change(event.target.value)}
			onBlur={field.finish}
			onKeyDown={(event) => {
				if (event.key === "Escape") event.currentTarget.blur();
			}}
			placeholder="Add a description…"
			aria-label="Description"
			className="field-sizing-content min-h-40 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
		/>
	);
}

function DeleteIssueDialog({
	issue,
	issueKey: key,
	onClose,
	onDeleted,
}: {
	issue: Issue;
	issueKey: string;
	onClose: () => void;
	onDeleted: () => void;
}) {
	const client = useSyncClient();

	function onDelete() {
		if (send(client, { name: "issue.delete", args: { id: issue.id } })) onDeleted();
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete {key}?</DialogTitle>
					<DialogDescription>
						“{issue.title}” will be deleted for everyone in the workspace.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onDelete}>
						Delete issue
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
