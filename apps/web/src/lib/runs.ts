import {
	RUN_STATES,
	type RunExecutor,
	type RunState,
	type RunWaitReason,
	type Signal,
	UNFINISHED_RUN_STATES,
} from "@gateweave/track-protocol";

/** A run signal: its kind is `run` and its state is one of the run lifecycle's. */
export type RunSignal = Omit<Signal, "kind" | "state"> & { kind: "run"; state: RunState };

export function isRunSignal(signal: Signal): signal is RunSignal {
	return signal.kind === "run" && (RUN_STATES as readonly string[]).includes(signal.state);
}

export function isUnfinishedRun(state: RunState): boolean {
	return (UNFINISHED_RUN_STATES as readonly string[]).includes(state);
}

/** An issue's runs, live ones first, each group newest report first. */
export function issueRuns(signals: Iterable<Signal>, issueId: string): RunSignal[] {
	return [...signals]
		.filter((signal): signal is RunSignal => isRunSignal(signal) && signal.issueId === issueId)
		.sort(
			(a, b) =>
				Number(isUnfinishedRun(b.state)) - Number(isUnfinishedRun(a.state)) ||
				b.changedAt - a.changedAt,
		);
}

export const RUN_EXECUTOR_LABELS: Record<RunExecutor, string> = {
	"agents-hosted": "Hosted",
	"local-runner": "Local runner",
	cloud: "Cloud",
};

export const RUN_WAIT_LABELS: Record<RunWaitReason, string> = {
	"waiting-for-slot": "Waiting for a slot",
	"runner-offline": "Runner offline",
	"needs-mapping": "Needs a repository mapping",
	"budget-limit": "Budget limit reached",
	retry: "Waiting to retry",
};

/**
 * The run's name on its row. A product names its run by its key, such as `deploy-7`. A scoped
 * attempt's key is its id, so it goes by its number instead: "Attempt 2".
 */
export function runTitle(run: Pick<Signal, "key" | "attemptNo">): string {
	return run.attemptNo === null ? run.key : `Attempt ${run.attemptNo}`;
}

/** Who runs it, as "Local runner · Codex", or null when the report named neither. */
export function runExecutorLabel(run: Pick<Signal, "executor" | "agentName">): string | null {
	if (run.executor === null) return run.agentName;
	const executor = RUN_EXECUTOR_LABELS[run.executor];
	return run.agentName === null ? executor : `${executor} · ${run.agentName}`;
}

/** Why a run waits, as "Runner offline · the machine slept", or null when it says nothing. */
export function runWaitLabel(run: Pick<Signal, "waitReason" | "waitDetail">): string | null {
	// A report may carry the detail without the reason; it is still the best explanation there is.
	if (run.waitReason === null) return run.waitDetail;
	const reason = RUN_WAIT_LABELS[run.waitReason];
	return run.waitDetail === null ? reason : `${reason} · ${run.waitDetail}`;
}
