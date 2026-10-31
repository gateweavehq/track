import {
	GITHUB_ACTOR_ID,
	type InboxEvent,
	type InboxItem,
	type Issue,
	mentionsAsText,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	CalendarClock,
	Check,
	Clock,
	GitPullRequest,
	Mail,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { PRIORITY_META, STATUS_META } from "#/components/issues/meta";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { actorName } from "#/lib/actors";
import { formatDateTime, formatRelative, formatShortDay, today } from "#/lib/dates";
import { useHotkeys } from "#/lib/hotkeys";
import {
	commentPreview,
	type InboxEntry,
	type InboxTab,
	inboxEntries,
	snoozeOptions,
} from "#/lib/inbox";
import { issueKey } from "#/lib/issues";
import { send } from "#/lib/mutations";
import {
	useCommentsById,
	useInbox,
	useIssuesById,
	useLabelsById,
	useMembersById,
	useProjectsById,
	useTeamsById,
} from "#/lib/queries";
import { cn } from "#/lib/utils";
import { useInboxClock } from "./hooks";

type InboxPatch = { read?: boolean; archived?: boolean; snoozedUntil?: number | null };

const TABS: { tab: InboxTab; label: string }[] = [
	{ tab: "inbox", label: "Inbox" },
	{ tab: "snoozed", label: "Snoozed" },
	{ tab: "archived", label: "Archived" },
];

const EMPTY: Record<InboxTab, { title: string; text: string }> = {
	inbox: {
		title: "You're all caught up",
		text: "Issues you are assigned, comments and status changes on issues you are subscribed to show up here.",
	},
	snoozed: {
		title: "Nothing snoozed",
		text: "Snooze an item to put it away until later. News on its issue brings it back sooner.",
	},
	archived: {
		title: "Nothing archived",
		text: "Archived items wait here. News on their issue brings them back to the inbox.",
	},
};

/**
 * The member's inbox: one row per issue with news for them. J/K or the arrow keys move between
 * rows, Enter opens the issue, U marks the row read or unread and E archives it.
 */
export function InboxPage({ tab }: { tab: InboxTab }) {
	const { slug } = useWorkspace();
	const client = useSyncClient();
	const items = useInbox();
	const issues = useIssuesById();
	const now = useInboxClock(items);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const rows = useRef(new Map<string, HTMLAnchorElement>());

	const entries = useMemo(
		() => inboxEntries(items.values(), issues, tab, now),
		[items, issues, tab, now],
	);
	const unread = entries.filter(({ item }) => item.unread > 0);

	const registerRow = useCallback((id: string, element: HTMLAnchorElement | null) => {
		if (element) rows.current.set(id, element);
		else rows.current.delete(id);
	}, []);

	function change(targets: InboxItem[], patch: InboxPatch) {
		if (targets.length === 0) return;
		send(client, {
			name: "inbox.update",
			args: {
				items: targets.map((item) => ({ issueId: item.issueId, seen: item.updatedAt })),
				patch,
			},
		});
	}

	/** Changes an item that may leave the tab, carrying the selection on to its neighbour. */
	function put(item: InboxItem, patch: InboxPatch) {
		const index = entries.findIndex((entry) => entry.item.id === item.id);
		change([item], patch);
		const neighbour = entries[index + 1] ?? entries[index - 1];
		if (item.id === selectedId && neighbour) {
			requestAnimationFrame(() => rows.current.get(neighbour.item.id)?.focus());
		}
	}

	const selected = entries.find(({ item }) => item.id === selectedId);
	function select(step: 1 | -1) {
		const index = entries.findIndex(({ item }) => item.id === selectedId);
		const next =
			index === -1 ? entries[step === 1 ? 0 : entries.length - 1] : entries[index + step];
		if (next) rows.current.get(next.item.id)?.focus();
	}
	const next = () => select(1);
	const previous = () => select(-1);
	useHotkeys({
		j: next,
		ArrowDown: next,
		k: previous,
		ArrowUp: previous,
		u: () => selected && change([selected.item], { read: selected.item.unread > 0 }),
		e: () => selected && put(selected.item, { archived: tab !== "archived" }),
	});

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
				<h1 className="sr-only">Inbox</h1>
				<nav aria-label="Inbox" className="flex items-center gap-1">
					{TABS.map(({ tab: target, label }) => (
						<Link
							key={target}
							to="/$workspace/inbox"
							params={{ workspace: slug }}
							search={target === "inbox" ? {} : { tab: target }}
							aria-current={target === tab ? "page" : undefined}
							className={cn(
								"rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
								target === tab && "bg-accent font-medium text-foreground",
							)}
						>
							{label}
						</Link>
					))}
				</nav>
				{tab === "inbox" && unread.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						className="ml-auto"
						onClick={() =>
							change(
								unread.map(({ item }) => item),
								{ read: true },
							)
						}
					>
						<Check />
						Mark all read
					</Button>
				)}
			</header>
			{entries.length === 0 ? (
				<Notice title={EMPTY[tab].title}>{EMPTY[tab].text}</Notice>
			) : (
				<ul aria-label={TABS.find((option) => option.tab === tab)?.label} className="p-2 sm:p-3">
					{entries.map((entry) => (
						<InboxRow
							key={entry.item.id}
							entry={entry}
							tab={tab}
							now={now}
							selected={entry.item.id === selectedId}
							onSelect={setSelectedId}
							onChange={(patch) => put(entry.item, patch)}
							registerRow={registerRow}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function InboxRow({
	entry,
	tab,
	now,
	selected,
	onSelect,
	onChange,
	registerRow,
}: {
	entry: InboxEntry;
	tab: InboxTab;
	now: number;
	selected: boolean;
	onSelect: (id: string) => void;
	onChange: (patch: InboxPatch) => void;
	registerRow: (id: string, element: HTMLAnchorElement | null) => void;
}) {
	const { slug } = useWorkspace();
	const teams = useTeamsById();
	const members = useMembersById();
	const { item, issue } = entry;
	const key = issueKey(teams.get(issue.teamId), issue);
	const actor = members.get(item.actorId);
	const github = item.actorId === GITHUB_ACTOR_ID;
	const reminder = item.actorId === SYSTEM_ACTOR_ID;
	const unread = item.unread > 0;

	return (
		<li
			data-selected={selected}
			onFocus={() => onSelect(item.id)}
			className="group relative flex items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50 data-[selected=true]:bg-accent"
		>
			<span
				aria-hidden
				className={cn(
					"mt-2 size-2 shrink-0 rounded-full",
					unread ? "bg-primary" : "bg-transparent",
				)}
			/>
			{github ? (
				<GitPullRequest
					aria-hidden
					className="mt-0.5 size-6 shrink-0 p-0.5 text-muted-foreground"
				/>
			) : reminder ? (
				<CalendarClock aria-hidden className="mt-0.5 size-6 shrink-0 p-0.5 text-muted-foreground" />
			) : (
				<MemberAvatar member={actor} className="mt-0.5 size-6" />
			)}
			<div className="min-w-0 flex-1 text-sm">
				<Link
					ref={(link) => registerRow(item.id, link)}
					to="/$workspace/issue/$issueKey"
					params={{ workspace: slug, issueKey: key }}
					className="flex min-w-0 items-baseline gap-2 outline-none after:absolute after:inset-0"
				>
					<span className="shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
					<span className={cn("truncate", unread && "font-medium")}>{issue.title}</span>
					{unread && <span className="sr-only">, unread</span>}
				</Link>
				<p className="truncate text-muted-foreground">
					<span className="text-foreground">{actorName(item.actorId, members)}</span>{" "}
					<EventText event={item.event} issue={issue} />
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{item.unread > 1 && (
					<span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
						{item.unread}
					</span>
				)}
				<time
					dateTime={new Date(item.updatedAt).toISOString()}
					title={formatDateTime(item.updatedAt)}
					className="text-xs whitespace-nowrap text-muted-foreground group-focus-within:hidden group-hover:hidden group-has-data-[state=open]:hidden"
				>
					{tab === "snoozed" && item.snoozedUntil !== null
						? `Until ${formatDateTime(item.snoozedUntil)}`
						: formatRelative(item.updatedAt, now)}
				</time>
				{/*
					Above the row's link, which covers the row. They stay while the snooze menu is open,
					though focus has left the row, so that the menu keeps its place beside them.
				*/}
				<div className="relative z-10 hidden items-center group-focus-within:flex group-hover:flex has-data-[state=open]:flex">
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={unread ? `Mark ${key} read` : `Mark ${key} unread`}
						onClick={() => onChange({ read: unread })}
					>
						{unread ? <Check /> : <Mail />}
					</Button>
					{tab !== "archived" && (
						<SnoozeMenu issueKey={key} snoozed={tab === "snoozed"} onChange={onChange} />
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={tab === "archived" ? `Unarchive ${key}` : `Archive ${key}`}
						onClick={() => onChange({ archived: tab !== "archived" })}
					>
						{tab === "archived" ? <ArchiveRestore /> : <Archive />}
					</Button>
				</div>
			</div>
		</li>
	);
}

function SnoozeMenu({
	issueKey: key,
	snoozed,
	onChange,
}: {
	issueKey: string;
	snoozed: boolean;
	onChange: (patch: InboxPatch) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className="size-7" aria-label={`Snooze ${key}`}>
					<Clock />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>Snooze until</DropdownMenuLabel>
				{snoozeOptions().map((option) => (
					<DropdownMenuItem
						key={option.label}
						onSelect={() => onChange({ snoozedUntil: option.until })}
					>
						{option.label}
						<span className="ml-auto pl-4 text-xs text-muted-foreground">
							{formatDateTime(option.until)}
						</span>
					</DropdownMenuItem>
				))}
				{snoozed && (
					<DropdownMenuItem onSelect={() => onChange({ snoozedUntil: null })}>
						Back to the inbox now
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** What the actor did, after their name: "commented: …", "assigned you". */
function EventText({ event, issue }: { event: InboxEvent; issue: Issue }) {
	const members = useMembersById();
	const labels = useLabelsById();
	const projects = useProjectsById();
	const comment = useCommentBody(
		event.type === "comment" || event.type === "mention" ? event.commentId : null,
	);
	const name = (id: string | null) => (id ? (members.get(id)?.name ?? "someone") : "nobody");
	const preview = (body: string) =>
		commentPreview(mentionsAsText(body, (id) => members.get(id)?.name));

	switch (event.type) {
		case "assigned":
			return <>assigned you</>;
		case "unassigned":
			return issue.assigneeId === null ? (
				<>unassigned you</>
			) : (
				<>assigned it to {name(issue.assigneeId)}</>
			);
		case "comment":
			return comment === null ? <>commented</> : <>commented: {preview(comment)}</>;
		case "status":
			return (
				<>
					moved it from {STATUS_META[event.from].label} to {STATUS_META[event.to].label}
				</>
			);
		case "proposal":
			return <>proposes {proposalText(event.change, name, labels, projects)}</>;
		case "mention":
			if (event.commentId === null) return <>mentioned you in the description</>;
			return comment === null ? (
				<>mentioned you in a comment</>
			) : (
				<>mentioned you: {preview(comment)}</>
			);
		case "due": {
			const day = today();
			if (event.on === day) return <>reminds you it is due today</>;
			const when = formatShortDay(event.on);
			return event.on < day ? (
				<>reminds you it was due {when}</>
			) : (
				<>reminds you it is due {when}</>
			);
		}
	}
}

function proposalText(
	change: Extract<InboxEvent, { type: "proposal" }>["change"],
	name: (id: string | null) => string,
	labels: ReadonlyMap<string, { name: string }>,
	projects: ReadonlyMap<string, { name: string }>,
): string {
	switch (change.type) {
		case "status":
			return `moving it to ${STATUS_META[change.to].label}`;
		case "priority":
			return change.to === 0
				? "removing the priority"
				: `the priority ${PRIORITY_META[change.to].label}`;
		case "assignee":
			return change.to === null ? "unassigning it" : `assigning ${name(change.to)}`;
		case "project":
			return change.to === null
				? "taking it out of its project"
				: `adding it to ${projects.get(change.to)?.name ?? "a deleted project"}`;
		case "title":
			return `renaming it to “${change.to}”`;
		case "description":
			return change.to === null ? "clearing the description" : "a new description";
		case "label": {
			const label = labels.get(change.labelId)?.name ?? "a deleted";
			return `${change.added ? "adding" : "removing"} the ${label} label`;
		}
	}
}

/** A comment's body, or null once it is deleted. */
function useCommentBody(commentId: string | null): string | null {
	const comments = useCommentsById();
	if (commentId === null) return null;
	return comments.get(commentId)?.body ?? null;
}
