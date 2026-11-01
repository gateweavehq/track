import { mutationSchema, type Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
	automationChoices,
	closeTarget,
	dueToArchive,
	dueToClose,
	monthsLabel,
} from "#/lib/automations";
import { send } from "#/lib/mutations";
import { useTeamIssues, useTeamStatuses } from "#/lib/queries";

const SELECT =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

const OFF = "off";

/** Says how many issues a rule would change on its first run, so no one is surprised by it. */
function firstRun(count: number, verb: string): string {
	if (count === 0) return `No issues would be ${verb} today.`;
	return count === 1
		? `1 issue would be ${verb} today.`
		: `${count} issues would be ${verb} today.`;
}

/**
 * Sets a team's automations: archiving closed issues, and closing issues nobody started, once no
 * one has touched them for a while. Admins only; the server checks again.
 */
export function AutomationsDialog({ team, onClose }: { team: Team; onClose: () => void }) {
	const client = useSyncClient();
	const id = useId();
	const statuses = useTeamStatuses(team.id);
	const issues = useTeamIssues(team.id);
	const [archiveAfter, setArchiveAfter] = useState(team.archiveAfterMonths);
	const [closeAfter, setCloseAfter] = useState(team.closeAfterMonths);
	const [error, setError] = useState<string | null>(null);
	const target = closeTarget(statuses);

	const archiving = useMemo(
		() => (archiveAfter === null ? 0 : dueToArchive(issues, statuses, archiveAfter).length),
		[issues, statuses, archiveAfter],
	);
	const closing = useMemo(
		() => (closeAfter === null ? 0 : dueToClose(issues, statuses, closeAfter).length),
		[issues, statuses, closeAfter],
	);

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const patch = {
			...(archiveAfter !== team.archiveAfterMonths && { archiveAfterMonths: archiveAfter }),
			...(closeAfter !== team.closeAfterMonths && { closeAfterMonths: closeAfter }),
		};
		if (Object.keys(patch).length === 0) {
			onClose();
			return;
		}
		const mutation = { name: "team.update" as const, args: { id: team.id, patch } };
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the settings");
			return;
		}
		if (send(client, mutation)) onClose();
	}

	const months = (value: string) => (value === OFF ? null : Number(value));

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Automations for {team.name}</DialogTitle>
					<DialogDescription>
						Track applies these about once a day, and notes each change in the issue's history. A
						month here is 30 days.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor={`${id}-archive`}>Archive closed issues</Label>
						<select
							id={`${id}-archive`}
							value={archiveAfter ?? OFF}
							onChange={(event) => {
								setArchiveAfter(months(event.target.value));
								setError(null);
							}}
							aria-describedby={`${id}-archive-hint`}
							className={SELECT}
						>
							<option value={OFF}>Never</option>
							{automationChoices(team.archiveAfterMonths).map((count) => (
								<option key={count} value={count}>
									After {monthsLabel(count)} untouched
								</option>
							))}
						</select>
						<p id={`${id}-archive-hint`} className="text-xs text-muted-foreground">
							Completed and canceled issues leave the team's lists for its archive, where they can
							be restored.
							{archiveAfter !== null && ` ${firstRun(archiving, "archived")}`}
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-close`}>Close stale issues</Label>
						<select
							id={`${id}-close`}
							value={closeAfter ?? OFF}
							disabled={!target && closeAfter === null}
							onChange={(event) => {
								setCloseAfter(months(event.target.value));
								setError(null);
							}}
							aria-describedby={`${id}-close-hint`}
							className={SELECT}
						>
							<option value={OFF}>Never</option>
							{automationChoices(team.closeAfterMonths).map((count) => (
								<option key={count} value={count}>
									After {monthsLabel(count)} untouched
								</option>
							))}
						</select>
						<p id={`${id}-close-hint`} className="text-xs text-muted-foreground">
							{target
								? `Backlog and unstarted issues move to ${target.name}. Work that has started is left alone.`
								: "Closing issues takes a canceled status to move them to, and this team has none."}
							{target && closeAfter !== null && ` ${firstRun(closing, "closed")}`}
						</p>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit">Save</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
