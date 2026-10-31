import {
	cycleEnd,
	dayIn,
	isTimeZone,
	MAX_CYCLE_WEEKS,
	mutationSchema,
	type Team,
} from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { earliestStart, localZone, startProblem, suggestedStart } from "#/lib/cycles";
import { send } from "#/lib/mutations";
import { useTeamCycles } from "#/lib/queries";
import { cycleDates } from "./meta";

const SELECT =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

const WEEKS = Array.from({ length: MAX_CYCLE_WEEKS }, (_, index) => index + 1);

/** Every time zone the browser knows, with `current` among them even if it does not. */
function timeZones(current: string): string[] {
	const known = Intl.supportedValuesOf("timeZone");
	return known.includes(current) ? known : [current, ...known];
}

/**
 * Turns a team's cycles on or off, or changes how long they run, when the next one starts and the
 * time zone their days follow. Admins only; the server checks again, by the same rules.
 */
export function CycleSettingsDialog({ team, onClose }: { team: Team; onClose: () => void }) {
	const client = useSyncClient();
	const cycles = useTeamCycles(team.id);
	const id = useId();
	const [enabled, setEnabled] = useState(team.cycles !== null);
	const [weeks, setWeeks] = useState(team.cycles?.weeks ?? 2);
	const [timeZone, setTimeZone] = useState(team.cycles?.timeZone ?? localZone());
	const today = dayIn(timeZone, Date.now());
	const [initialStart] = useState(() => suggestedStart(cycles, today));
	const [startsOn, setStartsOn] = useState(initialStart);
	const [error, setError] = useState<string | null>(null);
	const zones = useMemo(() => timeZones(timeZone), [timeZone]);
	const earliest = earliestStart(cycles, today);
	const turningOff = team.cycles !== null && !enabled;

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!enabled) {
			if (team.cycles)
				send(client, { name: "team.update", args: { id: team.id, patch: { cycles: null } } });
			onClose();
			return;
		}
		const unchanged =
			team.cycles?.weeks === weeks &&
			team.cycles.timeZone === timeZone &&
			startsOn === initialStart;
		if (unchanged) {
			onClose();
			return;
		}
		const problem = !isTimeZone(timeZone)
			? "Not a time zone"
			: startProblem(cycles, today, startsOn, weeks);
		if (problem) {
			setError(problem);
			return;
		}
		const mutation = {
			name: "team.update" as const,
			args: { id: team.id, patch: { cycles: { weeks, timeZone, startsOn } } },
		};
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the settings");
			return;
		}
		if (send(client, mutation)) onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Cycles for {team.name}</DialogTitle>
					<DialogDescription>
						A cycle is a fixed run of one to four weeks. Plan issues into it; what is not done when
						it ends moves on to the next one.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="flex items-center gap-2">
						<Checkbox
							id={`${id}-enabled`}
							checked={enabled}
							onCheckedChange={(checked) => {
								setEnabled(checked === true);
								setError(null);
							}}
						/>
						<Label htmlFor={`${id}-enabled`}>Work in cycles</Label>
					</div>
					{enabled ? (
						<>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor={`${id}-weeks`}>Length</Label>
									<select
										id={`${id}-weeks`}
										value={weeks}
										onChange={(event) => setWeeks(Number(event.target.value))}
										className={SELECT}
									>
										{WEEKS.map((count) => (
											<option key={count} value={count}>
												{count === 1 ? "1 week" : `${count} weeks`}
											</option>
										))}
									</select>
								</div>
								<div className="space-y-2">
									<Label htmlFor={`${id}-start`}>Next cycle starts</Label>
									<Input
										id={`${id}-start`}
										type="date"
										value={startsOn}
										min={earliest ?? undefined}
										required
										onChange={(event) => {
											setStartsOn(event.target.value);
											setError(null);
										}}
									/>
								</div>
							</div>
							<div className="space-y-2">
								<Label htmlFor={`${id}-zone`}>Time zone</Label>
								<select
									id={`${id}-zone`}
									value={timeZone}
									onChange={(event) => setTimeZone(event.target.value)}
									className={SELECT}
									aria-describedby={`${id}-zone-hint`}
								>
									{zones.map((zone) => (
										<option key={zone} value={zone}>
											{zone.replaceAll("_", " ")}
										</option>
									))}
								</select>
								<p id={`${id}-zone-hint`} className="text-xs text-muted-foreground">
									Cycles start and end at midnight here.
								</p>
							</div>
							{startsOn && (
								<p className="text-sm text-muted-foreground">
									The next cycle runs {cycleDates({ startsOn, endsOn: cycleEnd(startsOn, weeks) })},
									then a new one starts every {weeks === 1 ? "week" : `${weeks} weeks`}.
									{team.cycles &&
										" A cycle that has started stays as it is; upcoming ones move to the new dates and keep their issues."}
								</p>
							)}
						</>
					) : (
						turningOff && (
							<p className="text-sm text-muted-foreground">
								The current cycle ends today and upcoming cycles are deleted. Their unfinished
								issues leave them; completed cycles stay.
							</p>
						)
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant={turningOff ? "destructive" : "default"}>
							{turningOff ? "Turn off cycles" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
