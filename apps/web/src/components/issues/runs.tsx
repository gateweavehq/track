import type { Issue, RunState } from "@gateweave/track-protocol";
import {
	CheckCircle2,
	CircleSlash,
	Clock,
	ExternalLink,
	LoaderCircle,
	type LucideIcon,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "#/lib/dates";
import { useIssueRuns } from "#/lib/queries";
import {
	isUnfinishedRun,
	type RunSignal,
	runExecutorLabel,
	runTitle,
	runWaitLabel,
} from "#/lib/runs";
import { cn } from "#/lib/utils";

const STATE_META: Record<RunState, { label: string; icon: LucideIcon; className: string }> = {
	queued: { label: "Queued", icon: Clock, className: "text-muted-foreground" },
	running: { label: "Running", icon: LoaderCircle, className: "text-sky-500" },
	passed: { label: "Passed", icon: CheckCircle2, className: "text-emerald-500" },
	failed: { label: "Failed", icon: XCircle, className: "text-destructive" },
	cancelled: { label: "Cancelled", icon: CircleSlash, className: "text-muted-foreground" },
};

/**
 * The runs reported on the issue by connected products (WEB-84), live ones first. A run's
 * report names the issue by key; the row shows what the runner last said, never more.
 */
export function Runs({ issue }: { issue: Issue }) {
	const runs = useIssueRuns(issue.id);
	return <RunList runs={runs} />;
}

/** The runs given, such as an archived issue's. Nothing when there are none. */
export function RunList({ runs }: { runs: readonly RunSignal[] }) {
	const now = useLiveClock(runs);
	if (runs.length === 0) return null;
	const live = runs.filter((run) => isUnfinishedRun(run.state));
	const [latest, ...earlier] = runs.filter((run) => !isUnfinishedRun(run.state));
	const shown = latest === undefined ? live : [...live, latest];
	return (
		<section aria-labelledby="runs-heading" className="space-y-2">
			<h2 id="runs-heading" className="text-sm font-medium">
				Runs
			</h2>
			<ul className="rounded-lg border">
				{shown.map((run) => (
					<RunRow key={run.id} run={run} now={now} />
				))}
			</ul>
			{earlier.length > 0 && (
				<details className="text-sm">
					<summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">
						{earlier.length} earlier {earlier.length === 1 ? "run" : "runs"}
					</summary>
					<ul className="mt-2 rounded-lg border">
						{earlier.map((run) => (
							<RunRow key={run.id} run={run} now={now} />
						))}
					</ul>
				</details>
			)}
		</section>
	);
}

/**
 * The time relative labels are read against. It moves on when the runs change and, while a live
 * run is shown, every minute, so a run that stopped reporting still ages on screen; a list of
 * finished runs stays still, as every other relative time in the app does.
 */
function useLiveClock(runs: readonly RunSignal[]): number {
	const live = runs.some((run) => isUnfinishedRun(run.state));
	const [tick, setTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the clock is read again whenever the runs change or the timer fires.
	const now = useMemo(() => Date.now(), [runs, tick]);
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => setTick((t) => t + 1), 60_000);
		return () => clearInterval(timer);
	}, [live]);
	return now;
}

function RunRow({ run, now }: { run: RunSignal; now: number }) {
	const { label, icon: Icon, className } = STATE_META[run.state];
	const executor = runExecutorLabel(run);
	const explanation = runWaitLabel(run);
	const waiting = isUnfinishedRun(run.state) ? explanation : null;
	const refusal = run.state === "failed" && run.startedAt === null ? explanation : null;
	return (
		<li
			className={cn(
				"relative flex min-h-9 items-center gap-x-2 gap-y-1 border-b px-2 py-1 text-sm last:border-b-0 hover:bg-accent/40",
				refusal !== null && "flex-wrap",
			)}
		>
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
				// The attempt's id stays one hover away, for a runner log or a reconcile.
				title={run.attemptNo === null ? undefined : run.key}
			>
				{runTitle(run)}
			</span>
			<span className="flex min-w-0 flex-1 items-center gap-2">
				{executor !== null && <span className="shrink-0 text-muted-foreground">{executor}</span>}
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
			{refusal !== null && (
				<p className="basis-full wrap-anywhere pl-6 text-muted-foreground">{refusal}</p>
			)}
		</li>
	);
}

/** What the row says about time: a live run's start and last contact, a finished one's end. */
function timing(run: RunSignal, now: number): string {
	if (isUnfinishedRun(run.state)) {
		const parts: string[] = [];
		if (run.state === "running" && run.startedAt !== null)
			parts.push(`Started ${formatRelative(run.startedAt, now)}`);
		if (run.lastContactAt !== null)
			parts.push(`Last contact ${formatRelative(run.lastContactAt, now)}`);
		return parts.join(" · ");
	}
	return `Ended ${formatRelative(run.endedAt ?? run.changedAt, now)}`;
}
