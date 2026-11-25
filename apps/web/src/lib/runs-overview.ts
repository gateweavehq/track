import type { RunExecutor, Signal, SyncedIssue, Team } from "@gateweave/track-protocol";
import { z } from "zod";
import { isRunSignal, type RunSignal } from "./runs";

/** How long a failed run stays on the overview after it ends. */
export const RECENTLY_FAILED_WITHIN = 7 * 24 * 60 * 60 * 1000;

export const runsOverviewSearch = z.object({
	executor: z.enum(["agents-hosted", "local-runner", "cloud"]).optional().catch(undefined),
});

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
export function overviewRuns(
	signals: Iterable<Signal>,
	issues: ReadonlyMap<string, Pick<SyncedIssue, "teamId" | "number" | "title">>,
	teams: ReadonlyMap<string, Pick<Team, "key">>,
	now: number,
	executor?: RunExecutor,
): OverviewGroups {
	const rows: OverviewRow[] = [];
	for (const signal of signals) {
		if (!isRunSignal(signal) || signal.issueId === null) continue;
		if (executor !== undefined && signal.executor !== executor) continue;
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
		failed: rows
			.filter(
				(row) =>
					row.run.state === "failed" &&
					(row.run.endedAt ?? row.run.changedAt) >= now - RECENTLY_FAILED_WITHIN,
			)
			.sort(byReport),
	};
}

/** The executors the workspace's runs use, for the filter's chips, in the protocol's order. */
export function overviewExecutors(signals: Iterable<Signal>): RunExecutor[] {
	const seen = new Set<RunExecutor>();
	for (const signal of signals)
		if (isRunSignal(signal) && signal.executor !== null) seen.add(signal.executor);
	return (["agents-hosted", "local-runner", "cloud"] as const).filter((executor) =>
		seen.has(executor),
	);
}
