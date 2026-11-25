import {
	githubRepository,
	RUN_EXECUTORS,
	type RunExecutor,
	type Signal,
	type SyncedIssue,
	type Team,
} from "@gateweave/track-protocol";
import { z } from "zod";
import { isRunSignal, type RunSignal } from "./runs";

/** How long a failed run stays on the overview after it ends. */
export const RECENTLY_FAILED_WITHIN = 7 * 24 * 60 * 60 * 1000;

export const runsOverviewSearch = z.object({
	executor: z.enum(RUN_EXECUTORS).optional().catch(undefined),
	repository: githubRepository.optional().catch(undefined),
});

/** What the overview is narrowed to, as the address keeps it. */
export type RunsOverviewFilter = z.infer<typeof runsOverviewSearch>;

/** One row of the overview: the run with what links it to its issue. */
export interface OverviewRow {
	run: RunSignal;
	issueId: string;
	/** The issue's key, such as ENG-12, or null when the replica does not hold the issue. */
	issueKey: string | null;
	issueTitle: string | null;
}

export interface OverviewGroups {
	running: OverviewRow[];
	queued: OverviewRow[];
	failed: OverviewRow[];
}

/**
 * The workspace's runs for the overview (WEB-84): running and queued ones, and the ones that
 * failed within the week, each group with the most recent report first. Passed and cancelled
 * runs leave the page when they end — their issue rows keep them. Runs that never bound to an
 * issue stay in their executor's own view, as the pilot decided.
 */
/**
 * Whether a run belongs on the overview: it is running or queued, or it failed within the week.
 * Unbound runs stay in their executor's own view.
 */
function onOverview(signal: Signal, now: number): signal is RunSignal {
	if (!isRunSignal(signal) || signal.issueId === null) return false;
	if (signal.state === "running" || signal.state === "queued") return true;
	return (
		signal.state === "failed" &&
		(signal.endedAt ?? signal.changedAt) >= now - RECENTLY_FAILED_WITHIN
	);
}

export function overviewRuns(
	signals: Iterable<Signal>,
	issues: ReadonlyMap<string, Pick<SyncedIssue, "teamId" | "number" | "title">>,
	teams: ReadonlyMap<string, Pick<Team, "key">>,
	now: number,
	{ executor, repository }: RunsOverviewFilter = {},
): OverviewGroups {
	const rows: OverviewRow[] = [];
	for (const signal of signals) {
		if (!onOverview(signal, now) || signal.issueId === null) continue;
		if (executor !== undefined && signal.executor !== executor) continue;
		if (repository !== undefined && signal.repository !== repository) continue;
		const issue = issues.get(signal.issueId);
		const team = issue === undefined ? undefined : teams.get(issue.teamId);
		rows.push({
			run: signal,
			issueId: signal.issueId,
			issueKey: issue && team ? `${team.key}-${issue.number}` : null,
			issueTitle: issue?.title ?? null,
		});
	}
	const byReport = (a: OverviewRow, b: OverviewRow) => b.run.changedAt - a.run.changedAt;
	return {
		running: rows.filter((row) => row.run.state === "running").sort(byReport),
		queued: rows.filter((row) => row.run.state === "queued").sort(byReport),
		failed: rows.filter((row) => row.run.state === "failed").sort(byReport),
	};
}

/**
 * The executors of the runs the overview shows, for its filter, in the protocol's order. A run
 * that already left the page adds none, so no choice filters down to nothing.
 */
export function overviewExecutors(signals: Iterable<Signal>, now: number): RunExecutor[] {
	const seen = new Set<RunExecutor>();
	for (const signal of signals)
		if (onOverview(signal, now) && signal.executor !== null) seen.add(signal.executor);
	return RUN_EXECUTORS.filter((executor) => seen.has(executor));
}

/**
 * The repositories of the runs the overview shows, for its filter, in alphabetical order. Only a
 * scoped attempt has one, from its registration; a product's own runs add none.
 */
export function overviewRepositories(signals: Iterable<Signal>, now: number): string[] {
	const seen = new Set<string>();
	for (const signal of signals)
		if (onOverview(signal, now) && signal.repository !== null) seen.add(signal.repository);
	return [...seen].sort();
}
