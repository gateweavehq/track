import type { Cycle, CycleState } from "@gateweave/track-protocol";
import { IterationCcw } from "lucide-react";
import { formatShortDay } from "#/lib/dates";
import { cn } from "#/lib/utils";

export const CYCLE_STATE_LABEL: Record<CycleState, string> = {
	current: "Current",
	upcoming: "Upcoming",
	completed: "Completed",
};

/** A cycle's icon: the running cycle stands out, the others are quiet. */
export function CycleIcon({ state, className }: { state?: CycleState; className?: string }) {
	return (
		<IterationCcw
			aria-hidden
			className={cn(
				"size-4 shrink-0",
				state === "current" ? "text-primary" : "text-muted-foreground",
				className,
			)}
		/>
	);
}

/** "Nov 2 – Nov 8": the days a cycle runs, both included. */
export function cycleDates(cycle: Pick<Cycle, "startsOn" | "endsOn">): string {
	return `${formatShortDay(cycle.startsOn)} – ${formatShortDay(cycle.endsOn)}`;
}
