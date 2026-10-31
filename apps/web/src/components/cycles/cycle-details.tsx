import {
	type Cycle,
	type CycleState,
	dayIn,
	daysBetween,
	type Team,
} from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useMemo } from "react";
import { TextField } from "#/components/text-field";
import { burnUp, cycleName, cycleProgress, stateIn, teamZone } from "#/lib/cycles";
import { send } from "#/lib/mutations";
import { progressPercent } from "#/lib/projects";
import { useActivitiesById, useCycleIssues, useIssuesById } from "#/lib/queries";
import { BurnUpChart } from "./burn-up-chart";
import { CYCLE_STATE_LABEL, CycleIcon, cycleDates } from "./meta";

/**
 * A cycle's header: its name, which any member can change, when it runs, how far its work has
 * come, and a burn-up once it has started.
 */
export function CycleDetails({ cycle, team }: { cycle: Cycle; team: Team }) {
	const client = useSyncClient();
	const issues = useCycleIssues(cycle.id);
	const allIssues = useIssuesById();
	const activities = useActivitiesById();
	const now = Date.now();
	const state = stateIn(cycle, team, now);
	const zone = teamZone(team);
	const days = useMemo(
		() => burnUp(cycle, allIssues.values(), activities.values(), zone, Date.now()),
		[cycle, allIssues, activities, zone],
	);
	// A completed cycle's unfinished issues have moved on, so it is judged by its last day.
	const live = cycleProgress(issues);
	const final = days.at(-1);
	const progress =
		state === "completed" && final ? { done: final.done, total: final.scope } : live.issues;
	const percent = progressPercent(progress);
	const numbered = cycleName({ name: null, number: cycle.number });

	return (
		<section aria-label="Cycle details" className="space-y-4 border-b px-4 py-6 sm:px-6">
			<TextField
				value={cycleName(cycle)}
				onSave={(text) => {
					// Its number is its name until it is given another.
					const name = text.trim() === "" || text.trim() === numbered ? null : text.trim();
					if (name !== cycle.name) {
						send(client, { name: "cycle.update", args: { id: cycle.id, patch: { name } } });
					}
				}}
				label="Name"
				singleLine
				maxLength={64}
				className="text-2xl font-semibold tracking-tight"
			/>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				<span className="flex items-center gap-1.5">
					<CycleIcon state={state} />
					{CYCLE_STATE_LABEL[state]}
				</span>
				<span className="text-muted-foreground">{cycleDates(cycle)}</span>
				{state !== "completed" && (
					<span className="text-muted-foreground">{timing(cycle, state, dayIn(zone, now))}</span>
				)}
				<div
					className="ml-auto flex items-center gap-2 text-xs text-muted-foreground"
					title={`${progress.done} of ${progress.total} issues done`}
				>
					<div
						role="progressbar"
						aria-label="Progress"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						className="h-1.5 w-28 overflow-hidden rounded-full bg-muted"
					>
						<div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
					</div>
					<span className="tabular-nums" data-testid="cycle-progress">
						{progress.done}/{progress.total} done
					</span>
					{state !== "completed" && live.points.total > 0 && (
						<span className="tabular-nums">
							· {live.points.done}/{live.points.total} points
						</span>
					)}
				</div>
			</div>
			{days.length > 0 && (
				<BurnUpChart
					days={days}
					length={daysBetween(cycle.startsOn, cycle.endsOn) + 1}
					endsOn={cycle.endsOn}
				/>
			)}
		</section>
	);
}

/** "3 days left", "Starts in 5 days": a cycle that has not completed, against today. */
function timing(cycle: Cycle, state: Exclude<CycleState, "completed">, today: string): string {
	if (state === "upcoming") {
		const days = daysBetween(today, cycle.startsOn);
		return days === 1 ? "Starts tomorrow" : `Starts in ${days} days`;
	}
	// Today counts: on the day before the last there are two days left.
	const left = daysBetween(today, cycle.endsOn) + 1;
	return left <= 1 ? "Last day" : `${left} days left`;
}
