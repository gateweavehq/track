import { RUN_EXECUTORS, type RunExecutor, type RunState } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import {
	CheckCircle2,
	CircleSlash,
	Clock,
	ExternalLink,
	LoaderCircle,
	type LucideIcon,
	XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatRelative } from "#/lib/dates";
import { useIssuesById, useSignals, useTeamsById } from "#/lib/queries";
import { useRunClock } from "#/lib/run-clock";
import {
	isRunSignal,
	RUN_EXECUTOR_LABELS,
	type RunSignal,
	runExecutorLabel,
	runTitle,
	runWaitLabel,
} from "#/lib/runs";
import { type OverviewRow, overviewExecutors, overviewRuns } from "#/lib/runs-overview";
import { cn } from "#/lib/utils";

const STATE_META: Record<RunState, { label: string; icon: LucideIcon; className: string }> = {
	queued: { label: "Queued", icon: Clock, className: "text-muted-foreground" },
	running: { label: "Running", icon: LoaderCircle, className: "text-sky-500" },
	passed: { label: "Passed", icon: CheckCircle2, className: "text-emerald-500" },
	failed: { label: "Failed", icon: XCircle, className: "text-destructive" },
	cancelled: { label: "Cancelled", icon: CircleSlash, className: "text-muted-foreground" },
};

const GROUPS = [
	["running", "Running"],
	["queued", "Queued"],
	["failed", "Recently failed"],
] as const;

/**
 * The workspace's runs (WEB-84): what is running, what is waiting and what failed within the
 * week, so "why is it waiting and who has the slot" answers without opening three consoles.
 * Each row links to the issue the run works on.
 */
export function RunsOverviewPage({
	executorFilter,
	onExecutorFilterChange,
}: {
	executorFilter: RunExecutor | undefined;
	onExecutorFilterChange: (executor: RunExecutor | undefined) => void;
}) {
	const { slug } = useWorkspace();
	const signals = useSignals();
	const issues = useIssuesById();
	const teams = useTeamsById();
	const allRuns = useMemo(() => [...signals.values()].filter(isRunSignal), [signals]);
	const now = useRunClock(allRuns);
	// The filter offers the executors on the page, and keeps the one chosen even once its runs
	// have left, so the page never shows other executors' runs under it.
	const executors = useMemo(() => {
		const shown = overviewExecutors(signals.values(), now);
		return RUN_EXECUTORS.filter(
			(executor) => executor === executorFilter || shown.includes(executor),
		);
	}, [signals, now, executorFilter]);
	const groups = useMemo(
		() => overviewRuns(signals.values(), issues, teams, now, executorFilter),
		[signals, issues, teams, now, executorFilter],
	);
	const total = groups.running.length + groups.queued.length + groups.failed.length;

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">Runs</h1>
				<span className="text-sm text-muted-foreground tabular-nums">{total}</span>
				{executors.length > 0 && (
					<div className="ml-auto">
						<select
							aria-label="Filter by executor"
							value={executorFilter ?? ""}
							onChange={(event) =>
								onExecutorFilterChange((event.target.value || undefined) as RunExecutor | undefined)
							}
							className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<option value="">All executors</option>
							{executors.map((executor) => (
								<option key={executor} value={executor}>
									{RUN_EXECUTOR_LABELS[executor]}
								</option>
							))}
						</select>
					</div>
				)}
			</header>
			{total === 0 && executorFilter !== undefined ? (
				<Notice
					title={`No ${RUN_EXECUTOR_LABELS[executorFilter]} runs`}
					action={
						<Button variant="outline" size="sm" onClick={() => onExecutorFilterChange(undefined)}>
							Show all executors
						</Button>
					}
				>
					Nothing on {RUN_EXECUTOR_LABELS[executorFilter]} is running, waiting or failed within the
					week.
				</Notice>
			) : total === 0 ? (
				<Notice title="No runs">
					When an agent or a runner works on an issue, its run shows up here while it waits or runs,
					and for a week after it fails.
				</Notice>
			) : (
				<OverviewSections groups={groups} now={now} workspace={slug} />
			)}
		</div>
	);
}

/** The three groups given, as sections. Pure, so a test can render it without a replica. */
export function OverviewSections({
	groups,
	now,
	workspace,
}: {
	groups: ReturnType<typeof overviewRuns>;
	now: number;
	workspace: string;
}) {
	return (
		<div className="space-y-6 p-3 sm:p-4">
			{GROUPS.map(([group, title]) =>
				groups[group].length === 0 ? null : (
					<section key={group} aria-label={title} className="space-y-1">
						<h2 className="px-2 text-sm font-medium text-muted-foreground">
							{title}
							<span className="ml-1.5 tabular-nums">{groups[group].length}</span>
						</h2>
						<ul className="rounded-lg border">
							{groups[group].map((row) => (
								<OverviewRowItem key={row.run.id} row={row} now={now} workspace={workspace} />
							))}
						</ul>
					</section>
				),
			)}
		</div>
	);
}

function OverviewRowItem({
	row,
	now,
	workspace,
}: {
	row: OverviewRow;
	now: number;
	workspace: string;
}) {
	const { run } = row;
	const { label, icon: Icon, className } = STATE_META[run.state];
	const executor = runExecutorLabel(run);
	const waiting = runWaitLabel(run);
	return (
		<li className="relative flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1 text-sm last:border-b-0 hover:bg-accent/40">
			<Icon
				role="img"
				aria-label={label}
				className={cn("size-4 shrink-0", className, run.state === "running" && "animate-spin")}
			/>
			<span
				className={cn(
					"shrink-0 text-xs text-muted-foreground",
					run.attemptNo === null && "font-mono",
				)}
				title={run.attemptNo === null ? undefined : run.key}
			>
				{runTitle(run)}
			</span>
			{executor !== null && <span className="shrink-0 text-muted-foreground">{executor}</span>}
			{row.issueKey !== null ? (
				<Link
					to="/$workspace/issue/$issueKey"
					params={{ workspace, issueKey: row.issueKey }}
					className="flex min-w-0 max-w-64 items-baseline gap-1.5 outline-none hover:underline focus-visible:underline"
				>
					<span className="shrink-0 font-mono text-xs text-muted-foreground">{row.issueKey}</span>
					<span className="truncate">{row.issueTitle}</span>
				</Link>
			) : null}
			<span className="flex min-w-0 flex-1 items-center gap-2">
				{run.progress !== null && (
					<span className="truncate text-muted-foreground">{run.progress}</span>
				)}
				{waiting !== null && (
					<span className="min-w-0 wrap-anywhere text-amber-600 dark:text-amber-500">
						{waiting}
					</span>
				)}
			</span>
			<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
				{timing(run, now)}
			</span>
			{run.url !== null && (
				<a
					href={run.url}
					target="_blank"
					rel="noreferrer"
					aria-label="Open the run's link"
					className="shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
				>
					<ExternalLink className="size-3.5" />
				</a>
			)}
		</li>
	);
}

/** What the row says about time: a live run's start and last contact, a finished one's end. */
function timing(run: RunSignal, now: number): string {
	if (run.state === "queued" || run.state === "running") {
		const parts: string[] = [];
		if (run.state === "running" && run.startedAt !== null)
			parts.push(`Started ${formatRelative(run.startedAt, now)}`);
		if (run.lastContactAt !== null)
			parts.push(`Last contact ${formatRelative(run.lastContactAt, now)}`);
		return parts.join(" · ");
	}
	return `Ended ${formatRelative(run.endedAt ?? run.changedAt, now)}`;
}
