import { useEffect, useMemo, useState } from "react";
import { isUnfinishedRun, type RunSignal } from "./runs";

/**
 * The time relative run labels are read against. It moves on when the runs change and, while a
 * live run is shown, every minute, so a run that stopped reporting still ages on screen; a list
 * of finished runs stays still, as every other relative time in the app does.
 */
export function useRunClock(runs: readonly RunSignal[]): number {
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
