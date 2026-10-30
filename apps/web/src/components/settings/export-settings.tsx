import { Download } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { useTeams } from "#/lib/queries";
import { useExportIssues } from "#/lib/use-export";

export function ExportSettings() {
	const teams = useTeams();
	const exportIssues = useExportIssues();
	const selectId = useId();
	// "" is every team. A team that disappears while the page is open falls back to all.
	const [choice, setChoice] = useState("");
	const teamId = teams.some((team) => team.id === choice) ? choice : null;

	return (
		<section aria-labelledby="export-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="export-heading" className="text-base font-semibold">
					Export
				</h2>
				<p className="text-sm text-muted-foreground">
					Download your issues from the copy this browser holds, so it also works offline. CSV has
					one row per issue and opens in a spreadsheet. JSON also holds teams, members, labels,
					projects, comments and activity. Any member can export.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor={selectId}>Team</Label>
				<select
					id={selectId}
					value={teamId ?? ""}
					onChange={(event) => setChoice(event.target.value)}
					className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
				>
					<option value="">All teams</option>
					{teams.map((team) => (
						<option key={team.id} value={team.id}>
							{team.name} ({team.key})
						</option>
					))}
				</select>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => exportIssues("csv", teamId)}>
					<Download />
					Export CSV
				</Button>
				<Button variant="outline" onClick={() => exportIssues("json", teamId)}>
					<Download />
					Export JSON
				</Button>
			</div>
		</section>
	);
}
