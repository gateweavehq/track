import type { Cycle, CycleState, Issue, Team } from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { burnUp, cycleName, cycleProgress, stateIn, teamZone } from "#/lib/cycles";
import { type ProjectProgress, progressPercent } from "#/lib/projects";
import { useActivitiesById, useIssuesById, useTeamCycles } from "#/lib/queries";
import { CycleSettingsDialog } from "./cycle-settings-dialog";
import { CYCLE_STATE_LABEL, CycleIcon, cycleDates } from "./meta";

interface CycleRowData {
	cycle: Cycle;
	state: CycleState;
	progress: ProjectProgress;
}

const SECTIONS: CycleState[] = ["current", "upcoming", "completed"];

/** A team's cycles: the running one, those to come, and those done, newest first. */
export function TeamCyclesPage({ team }: { team: Team }) {
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const cycles = useTeamCycles(team.id);
	const issues = useIssuesById();
	const activities = useActivitiesById();
	const [editing, setEditing] = useState(false);

	const rows = useMemo(() => {
		const now = Date.now();
		const byCycle = new Map<string, Issue[]>();
		for (const issue of issues.values()) {
			if (issue.cycleId === null) continue;
			const planned = byCycle.get(issue.cycleId);
			if (planned) planned.push(issue);
			else byCycle.set(issue.cycleId, [issue]);
		}
		return cycles.map((cycle): CycleRowData => {
			const state = stateIn(cycle, team, now);
			if (state !== "completed") {
				return { cycle, state, progress: cycleProgress(byCycle.get(cycle.id) ?? []).issues };
			}
			// Its unfinished issues have moved on since, so it is judged by its last day.
			const last = burnUp(cycle, issues.values(), activities.values(), teamZone(team), now).at(-1);
			return { cycle, state, progress: { done: last?.done ?? 0, total: last?.scope ?? 0 } };
		});
	}, [cycles, issues, activities, team]);

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">Cycles</h1>
				<Link
					to="/$workspace/team/$teamKey"
					params={{ workspace: slug, teamKey: team.key }}
					className="rounded border px-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
				>
					{team.key}
				</Link>
				{admin && (
					<Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing(true)}>
						<Settings2 />
						<span className="hidden sm:inline">Cycle settings</span>
					</Button>
				)}
			</header>
			{!team.cycles && (
				<Notice
					title={`${team.name} does not work in cycles`}
					action={admin && <Button onClick={() => setEditing(true)}>Turn on cycles</Button>}
				>
					A cycle is a fixed run of one to four weeks. Plan issues into it; what is not done when it
					ends moves on to the next one.
					{!admin && " An admin can turn cycles on."}
				</Notice>
			)}
			{SECTIONS.map((state) => {
				const section = rows.filter((row) => row.state === state);
				if (state === "completed") section.reverse();
				if (section.length === 0) return null;
				return (
					<section key={state} aria-labelledby={`cycles-${state}`}>
						<h2
							id={`cycles-${state}`}
							className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground sm:px-4"
						>
							{CYCLE_STATE_LABEL[state]}
						</h2>
						<ul>
							{section.map((row) => (
								<CycleRow key={row.cycle.id} row={row} />
							))}
						</ul>
					</section>
				);
			})}
			{editing && <CycleSettingsDialog team={team} onClose={() => setEditing(false)} />}
		</div>
	);
}

function CycleRow({ row: { cycle, state, progress } }: { row: CycleRowData }) {
	const { slug } = useWorkspace();
	const percent = progressPercent(progress);
	return (
		<li className="relative flex min-h-12 items-center gap-3 border-b px-3 py-2 text-sm hover:bg-accent/40 sm:px-4">
			<CycleIcon state={state} />
			<Link
				to="/$workspace/cycle/$cycleId"
				params={{ workspace: slug, cycleId: cycle.id }}
				className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				{cycleName(cycle)}
				{cycle.name !== null && (
					<span className="ml-2 font-normal text-muted-foreground">Cycle {cycle.number}</span>
				)}
			</Link>
			<span className="hidden w-40 shrink-0 text-xs text-muted-foreground sm:block">
				{cycleDates(cycle)}
			</span>
			<div
				className="flex w-28 shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-36"
				title={`${progress.done} of ${progress.total} issues done`}
			>
				<div
					role="progressbar"
					aria-label={`${cycleName(cycle)} progress`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
				>
					<div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
				</div>
				<span className="w-10 text-right tabular-nums">
					{progress.done}/{progress.total}
				</span>
			</div>
		</li>
	);
}
