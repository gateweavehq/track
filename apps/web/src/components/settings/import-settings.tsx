import type { MutationInput } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { FileUp, Upload } from "lucide-react";
import { type ComponentType, useEffect, useId, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { readCsvImport } from "#/lib/import/csv";
import {
	type ImportPlan,
	type ImportProgress,
	type ImportSource,
	importTargetFrom,
	planImport,
	runImport,
} from "#/lib/import/plan";
import { useTeams } from "#/lib/queries";

/** What a source's form hands over: the issues it read, and anything worth telling about them. */
export interface LoadedImport {
	source: ImportSource;
	notes: string[];
}

/** A place issues can come from. Each has a form that reads them into an `ImportSource`. */
interface ImportSourceOption {
	id: string;
	label: string;
	Form: ComponentType<{ onLoaded: (loaded: LoadedImport) => void }>;
}

const SOURCES: ImportSourceOption[] = [{ id: "csv", label: "CSV file", Form: CsvForm }];

type Step =
	| { name: "choose" }
	| { name: "review"; loaded: LoadedImport }
	| { name: "done"; plan: ImportPlan; progress: ImportProgress; stopped: boolean };

export function ImportSettings() {
	const admin = isAdmin(useMyRole());
	const [step, setStep] = useState<Step>({ name: "choose" });

	return (
		<section aria-labelledby="import-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="import-heading" className="text-base font-semibold">
					Import
				</h2>
				<p className="text-sm text-muted-foreground">
					Bring issues from another tracker into a team, with their labels, comments and original
					dates. Running an import again skips what it brought in before, so it is safe to repeat.
				</p>
			</div>
			{!admin ? (
				<p className="text-sm text-muted-foreground">Only owners and admins can import.</p>
			) : step.name === "choose" ? (
				<ChooseSource onLoaded={(loaded) => setStep({ name: "review", loaded })} />
			) : step.name === "done" ? (
				<ImportResult
					plan={step.plan}
					progress={step.progress}
					stopped={step.stopped}
					onAgain={() => setStep({ name: "choose" })}
				/>
			) : (
				<ReviewAndRun
					loaded={step.loaded}
					onCancel={() => setStep({ name: "choose" })}
					onDone={(plan, progress, stopped) => setStep({ name: "done", plan, progress, stopped })}
				/>
			)}
		</section>
	);
}

function ChooseSource({ onLoaded }: { onLoaded: (loaded: LoadedImport) => void }) {
	const [sourceId, setSourceId] = useState(SOURCES[0]?.id);
	const source = SOURCES.find((option) => option.id === sourceId) ?? SOURCES[0];
	if (!source) return null;
	return (
		<div className="space-y-4">
			{SOURCES.length > 1 && (
				<fieldset className="flex flex-wrap gap-2">
					<legend className="sr-only">Import from</legend>
					{SOURCES.map((option) => (
						<Button
							key={option.id}
							type="button"
							size="sm"
							variant={option.id === source.id ? "secondary" : "outline"}
							aria-pressed={option.id === source.id}
							onClick={() => setSourceId(option.id)}
						>
							{option.label}
						</Button>
					))}
				</fieldset>
			)}
			<source.Form onLoaded={onLoaded} />
		</div>
	);
}

function CsvForm({ onLoaded }: { onLoaded: (loaded: LoadedImport) => void }) {
	const client = useSyncClient();
	const inputId = useId();
	const [error, setError] = useState<string | null>(null);

	async function read(file: File) {
		setError(null);
		try {
			const labels = [...client.getState().labels.values()].map((label) => label.name);
			const { source, ignored } = readCsvImport(await file.text(), labels);
			onLoaded({
				source,
				notes: ignored.length > 0 ? [`Columns left out: ${ignored.join(", ")}.`] : [],
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}

	return (
		<div className="space-y-2">
			<Label htmlFor={inputId}>CSV file</Label>
			<p className="text-sm text-muted-foreground">
				One row per issue, with a title column. Track's own export reads back as it was; other files
				are read by column names such as Status, Priority, Assignee, Labels and Due date.
			</p>
			<label
				htmlFor={inputId}
				className="flex max-w-md cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground hover:bg-accent focus-within:ring-1 focus-within:ring-ring"
			>
				<FileUp aria-hidden className="size-4" />
				Choose a .csv file
				<input
					id={inputId}
					type="file"
					accept=".csv,text/csv"
					className="sr-only"
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) void read(file);
					}}
				/>
			</label>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

function ReviewAndRun({
	loaded,
	onCancel,
	onDone,
}: {
	loaded: LoadedImport;
	onCancel: () => void;
	onDone: (plan: ImportPlan, progress: ImportProgress, stopped: boolean) => void;
}) {
	const client = useSyncClient();
	const teams = useTeams();
	const selectId = useId();
	const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
	const [plan, setPlan] = useState<ImportPlan | null>(null);
	const [progress, setProgress] = useState<ImportProgress | null>(null);
	const abort = useRef<AbortController | null>(null);

	// The plan reads the workspace as it is now, so it is made again for another team.
	useEffect(() => {
		if (!teamId) return;
		let current = true;
		setPlan(null);
		void planImport(loaded.source, importTargetFrom(client.getState()), teamId).then((next) => {
			if (current) setPlan(next);
		});
		return () => {
			current = false;
		};
	}, [client, loaded, teamId]);

	// Leaving the page stops sending; what was sent still reaches the server.
	useEffect(() => () => abort.current?.abort(), []);

	async function start() {
		if (!plan) return;
		const controller = new AbortController();
		abort.current = controller;
		const mutate = (mutation: MutationInput) => {
			try {
				return client.mutate(mutation);
			} catch (error) {
				return Promise.reject(error);
			}
		};
		setProgress({ done: 0, total: plan.mutations.length, failed: [] });
		const result = await runImport(mutate, plan.mutations, setProgress, controller.signal);
		onDone(plan, result, controller.signal.aborted);
	}

	if (teams.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				Create a team first: imported issues go into one.{" "}
				<Button variant="link" className="h-auto p-0" onClick={onCancel}>
					Back
				</Button>
			</p>
		);
	}

	const running = progress !== null;
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor={selectId}>Into team</Label>
				<select
					id={selectId}
					value={teamId}
					disabled={running}
					onChange={(event) => setTeamId(event.target.value)}
					className="flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 md:text-sm"
				>
					{teams.map((team) => (
						<option key={team.id} value={team.id}>
							{team.name} ({team.key})
						</option>
					))}
				</select>
			</div>
			<div aria-live="polite" className="space-y-1 rounded-md border p-3 text-sm">
				{plan ? <PlanSummary sourceName={loaded.source.name} plan={plan} /> : <p>Reading…</p>}
				{loaded.notes.map((note) => (
					<p key={note} className="text-muted-foreground">
						{note}
					</p>
				))}
			</div>
			{progress ? (
				<div className="space-y-2">
					<progress
						aria-label="Import progress"
						value={progress.done}
						max={Math.max(progress.total, 1)}
						className="h-2 w-full max-w-md overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
					/>
					<p className="text-sm text-muted-foreground">
						{progress.done} of {progress.total} changes saved. Keep this page open until it
						finishes; if it closes, import the same file again to finish.
					</p>
					<Button variant="outline" size="sm" onClick={() => abort.current?.abort()}>
						Stop
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					<Button disabled={!plan || plan.mutations.length === 0} onClick={() => void start()}>
						<Upload />
						{plan && plan.issues > 0 ? `Import ${countOf(plan.issues, "issue")}` : "Import"}
					</Button>
					<Button variant="ghost" onClick={onCancel}>
						Back
					</Button>
				</div>
			)}
		</div>
	);
}

function PlanSummary({ sourceName, plan }: { sourceName: string; plan: ImportPlan }) {
	if (plan.mutations.length === 0) {
		return <p>Everything here was imported before. There is nothing new to bring in.</p>;
	}
	return (
		<>
			<p>
				From {sourceName}: {contents(plan)}.
			</p>
			{plan.skipped > 0 && (
				<p className="text-muted-foreground">
					{countOf(plan.skipped, "item")} imported before will be skipped.
				</p>
			)}
			{plan.newLabels.length > 0 && (
				<p className="text-muted-foreground">New labels: {plan.newLabels.join(", ")}.</p>
			)}
			{plan.newProjects.length > 0 && (
				<p className="text-muted-foreground">New projects: {plan.newProjects.join(", ")}.</p>
			)}
		</>
	);
}

function ImportResult({
	plan,
	progress,
	stopped,
	onAgain,
}: {
	plan: ImportPlan;
	progress: ImportProgress;
	stopped: boolean;
	onAgain: () => void;
}) {
	const failed = progress.failed;
	return (
		<div className="space-y-3">
			<p role="status" className="text-sm">
				{stopped
					? `Stopped after ${progress.done} of ${progress.total} changes. Import the same source again to bring in the rest.`
					: failed.length === 0
						? `Imported ${contents(plan)}.`
						: `Imported, but the server refused ${countOf(failed.length, "change")}.`}
			</p>
			{failed.length > 0 && (
				<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					{failed.slice(0, 5).map((failure, index) => (
						// Failures have no id of their own and never reorder.
						// biome-ignore lint/suspicious/noArrayIndexKey: as above
						<li key={index}>
							{describeMutation(failure.mutation)}: {failure.message}
						</li>
					))}
					{failed.length > 5 && <li>and {failed.length - 5} more</li>}
				</ul>
			)}
			<Button variant="outline" onClick={onAgain}>
				Import more
			</Button>
		</div>
	);
}

function describeMutation(mutation: MutationInput): string {
	switch (mutation.name) {
		case "issue.create":
			return `“${mutation.args.title}”`;
		case "comment.create":
			return "A comment";
		case "label.create":
			return `The label “${mutation.args.name}”`;
		case "project.create":
			return `The project “${mutation.args.name}”`;
		default:
			return mutation.name;
	}
}

/** "3 issues", or "3 issues and 5 comments" when there are comments to bring in. */
function contents(plan: ImportPlan): string {
	const issues = countOf(plan.issues, "issue");
	return plan.comments > 0 ? `${issues} and ${countOf(plan.comments, "comment")}` : issues;
}

function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
