import type { MutationInput } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { FileUp, Upload } from "lucide-react";
import { type ComponentType, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { readCsvImport } from "#/lib/import/csv";
import { parseRepository, readGitHubImport } from "#/lib/import/github";
import { readJsonImport } from "#/lib/import/json";
import { type LinearTeam, listLinearTeams, readLinearImport } from "#/lib/import/linear";
import {
	type ImportPlan,
	type ImportProgress,
	type ImportSource,
	importTargetFrom,
	planImport,
	type ReadOptions,
	runImport,
} from "#/lib/import/plan";
import { useTeams } from "#/lib/queries";
import { cn } from "#/lib/utils";

/** What a source's form hands over: the issues it read, and anything worth telling about them. */
export interface LoadedImport {
	source: ImportSource;
	notes: string[];
}

/** A place issues can come from. Each has a form that reads them into an `ImportSource`. */
interface ImportSourceOption {
	id: string;
	label: string;
	Form: ComponentType<SourceFormProps>;
}

const SOURCES: ImportSourceOption[] = [
	{ id: "github", label: "GitHub", Form: GitHubForm },
	{ id: "linear", label: "Linear", Form: LinearForm },
	{ id: "file", label: "File", Form: FileForm },
];

/** The "Into team" choice that keeps each issue in the team the source has it in. */
const SOURCE_TEAMS = "source-teams";

const SELECT_CLASS =
	"flex h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 md:text-sm";

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
					Bring issues from another tracker or another Track workspace, with their labels, comments
					and original dates. Running an import again skips what it brought in before, so it is safe
					to repeat.
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
				<fieldset className="flex w-fit rounded-md border p-0.5">
					<legend className="sr-only">Import from</legend>
					{SOURCES.map((option) => (
						<button
							key={option.id}
							type="button"
							aria-pressed={option.id === source.id}
							onClick={() => setSourceId(option.id)}
							className={cn(
								"h-7 rounded-sm px-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								option.id === source.id && "bg-accent font-medium text-foreground",
							)}
						>
							{option.label}
						</button>
					))}
				</fieldset>
			)}
			<source.Form onLoaded={onLoaded} />
		</div>
	);
}

type SourceFormProps = { onLoaded: (loaded: LoadedImport) => void };

/** Reading from another service: how far it got, why it failed, and a way to stop it. */
function useRemoteRead(service: string) {
	const [reading, setReading] = useState<{ issues: number; comments: number } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abort = useRef<AbortController | null>(null);
	useEffect(() => () => abort.current?.abort(), []);

	async function run<T>(read: (options: ReadOptions) => Promise<T>): Promise<T | null> {
		abort.current?.abort();
		const controller = new AbortController();
		abort.current = controller;
		setError(null);
		setReading({ issues: 0, comments: 0 });
		try {
			return await read({ signal: controller.signal, onProgress: setReading });
		} catch (caught) {
			if (!controller.signal.aborted) {
				// fetch rejects with a TypeError when the request never got an answer.
				setError(
					caught instanceof TypeError
						? `Could not reach ${service}. Check the connection and try again.`
						: caught instanceof Error
							? caught.message
							: String(caught),
				);
			}
			return null;
		} finally {
			if (abort.current === controller) {
				abort.current = null;
				setReading(null);
			}
		}
	}

	return { reading, error, run, stop: () => abort.current?.abort() };
}

function ReadButton({
	label,
	reading,
	onStop,
}: {
	label: string;
	reading: { issues: number; comments: number } | null;
	onStop: () => void;
}) {
	if (!reading) return <Button type="submit">{label}</Button>;
	return (
		<div className="flex flex-wrap items-center gap-3">
			<p aria-live="polite" className="text-sm text-muted-foreground">
				{reading.issues === 0 && reading.comments === 0
					? "Reading…"
					: `Read ${countOf(reading.issues, "issue")} and ${countOf(reading.comments, "comment")}…`}
			</p>
			<Button type="button" variant="outline" size="sm" onClick={onStop}>
				Stop
			</Button>
		</div>
	);
}

function FormError({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p role="alert" className="text-sm text-destructive">
			{error}
		</p>
	);
}

function GitHubForm({ onLoaded }: SourceFormProps) {
	const repositoryId = useId();
	const tokenId = useId();
	const [repository, setRepository] = useState("");
	const [token, setToken] = useState("");
	const [invalid, setInvalid] = useState(false);
	const { reading, error, run, stop } = useRemoteRead("GitHub");

	async function submit(event: FormEvent) {
		event.preventDefault();
		const parsed = parseRepository(repository);
		setInvalid(!parsed);
		if (!parsed) return;
		const source = await run((options) => readGitHubImport(parsed, token, options));
		if (!source) return;
		onLoaded({
			source,
			notes:
				source.pullRequests > 0
					? [`${countOf(source.pullRequests, "pull request")} left out.`]
					: [],
		});
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
			<div className="space-y-2">
				<Label htmlFor={repositoryId}>Repository</Label>
				<Input
					id={repositoryId}
					value={repository}
					onChange={(event) => setRepository(event.target.value)}
					placeholder="owner/name"
					autoComplete="off"
					spellCheck={false}
					required
					aria-invalid={invalid}
					disabled={reading !== null}
				/>
				{invalid && (
					<p className="text-sm text-destructive">
						Enter the repository as owner/name, or paste a link to it.
					</p>
				)}
			</div>
			<div className="space-y-2">
				<Label htmlFor={tokenId}>
					Access token <span className="font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Input
					id={tokenId}
					type="password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					autoComplete="off"
					spellCheck={false}
					aria-describedby={`${tokenId}-help`}
					disabled={reading !== null}
				/>
				<p id={`${tokenId}-help`} className="text-sm text-muted-foreground">
					Needed for a private repository, and for a large one: without a token, GitHub allows 60
					requests an hour, about 6,000 issues and comments. A fine-grained token that can read
					issues is enough. It goes only to GitHub and is not saved.
				</p>
			</div>
			<ReadButton label="Read issues" reading={reading} onStop={stop} />
			<FormError error={error} />
		</form>
	);
}

function LinearForm({ onLoaded }: SourceFormProps) {
	const keyId = useId();
	const teamId = useId();
	const [apiKey, setApiKey] = useState("");
	const [teams, setTeams] = useState<LinearTeam[] | null>(null);
	const [team, setTeam] = useState("");
	const { reading, error, run, stop } = useRemoteRead("Linear");

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!apiKey.trim()) return;
		if (!teams) {
			const found = await run((options) => listLinearTeams(apiKey, options));
			if (found) {
				setTeams(found);
				setTeam(found[0]?.id ?? "");
			}
			return;
		}
		const chosen = teams.find((option) => option.id === team);
		if (!chosen) return;
		const source = await run((options) => readLinearImport(apiKey, chosen, options));
		if (!source) return;
		// Files uploaded to Linear are only served to people signed in to it.
		const uploads = source.issues.some(
			(issue) =>
				issue.description?.includes("uploads.linear.app") ||
				issue.comments.some((comment) => comment.body.includes("uploads.linear.app")),
		);
		onLoaded({
			source,
			notes: uploads
				? [
						"Images and files uploaded to Linear stay there as links, which open only when signed in to Linear.",
					]
				: [],
		});
	}

	return (
		<form onSubmit={(event) => void submit(event)} className="max-w-md space-y-4">
			<div className="space-y-2">
				<Label htmlFor={keyId}>API key</Label>
				<Input
					id={keyId}
					type="password"
					value={apiKey}
					onChange={(event) => {
						setApiKey(event.target.value);
						setTeams(null);
					}}
					autoComplete="off"
					spellCheck={false}
					required
					aria-describedby={`${keyId}-help`}
					disabled={reading !== null}
				/>
				<p id={`${keyId}-help`} className="text-sm text-muted-foreground">
					A personal API key, made in Linear's settings under Security &amp; access. It goes only to
					Linear and is not saved.
				</p>
			</div>
			{teams && teams.length === 0 && (
				<p className="text-sm text-muted-foreground">This key sees no teams in Linear.</p>
			)}
			{teams && teams.length > 0 && (
				<div className="space-y-2">
					<Label htmlFor={teamId}>Linear team</Label>
					<select
						id={teamId}
						value={team}
						disabled={reading !== null}
						onChange={(event) => setTeam(event.target.value)}
						className={SELECT_CLASS}
					>
						{teams.map((option) => (
							<option key={option.id} value={option.id}>
								{option.name} ({option.key})
							</option>
						))}
					</select>
				</div>
			)}
			<ReadButton label={teams ? "Read issues" : "Connect"} reading={reading} onStop={stop} />
			<FormError error={error} />
		</form>
	);
}

/** A JSON file is Track's own export; anything else is read as CSV. */
function isJson(file: File, text: string): boolean {
	return /\.json$/i.test(file.name) || /^\uFEFF?\s*\{/.test(text);
}

function FileForm({ onLoaded }: SourceFormProps) {
	const client = useSyncClient();
	const inputId = useId();
	const [error, setError] = useState<string | null>(null);

	async function read(file: File) {
		setError(null);
		try {
			const text = await file.text();
			if (isJson(file, text)) {
				onLoaded(readJsonImport(text));
				return;
			}
			const labels = [...client.getState().labels.values()].map((label) => label.name);
			const { source, ignored } = readCsvImport(text, labels);
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
			<Label htmlFor={inputId}>CSV or JSON file</Label>
			<p className="text-sm text-muted-foreground">
				Track's own exports read back as they were; JSON brings comments and relations too. Other
				CSV files need one row per issue with a title column, and are read by column names such as
				Status, Priority, Assignee, Labels and Due date.
			</p>
			<label
				htmlFor={inputId}
				className="flex max-w-md cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground hover:bg-accent focus-within:ring-1 focus-within:ring-ring"
			>
				<FileUp aria-hidden className="size-4" />
				Choose a .csv or .json file
				<input
					id={inputId}
					type="file"
					accept=".csv,.json,text/csv,application/json"
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
	// The teams the source keeps its issues in, such as a Track export's, offered as a choice.
	const [sourceTeams] = useState(() => [
		...new Set(loaded.source.issues.flatMap((issue) => (issue.team ? [issue.team.key] : []))),
	]);
	const [keepTeams, setKeepTeams] = useState(sourceTeams.length > 0);
	const [plan, setPlan] = useState<ImportPlan | null>(null);
	const [progress, setProgress] = useState<ImportProgress | null>(null);
	const abort = useRef<AbortController | null>(null);

	// The plan reads the workspace as it is now, so it is made again for another team.
	useEffect(() => {
		if (!teamId) return;
		let current = true;
		setPlan(null);
		void planImport(loaded.source, importTargetFrom(client.getState()), teamId, {
			keepTeams,
		}).then((next) => {
			if (current) setPlan(next);
		});
		return () => {
			current = false;
		};
	}, [client, loaded, teamId, keepTeams]);

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
					value={keepTeams ? SOURCE_TEAMS : teamId}
					disabled={running}
					onChange={(event) => {
						const value = event.target.value;
						setKeepTeams(value === SOURCE_TEAMS);
						if (value !== SOURCE_TEAMS) setTeamId(value);
					}}
					className={SELECT_CLASS}
				>
					{sourceTeams.length > 0 && (
						<option value={SOURCE_TEAMS}>Their own teams ({sourceTeams.join(", ")})</option>
					)}
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
			{plan.newTeams.length > 0 && (
				<p className="text-muted-foreground">New teams: {plan.newTeams.join(", ")}.</p>
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
		case "team.create":
			return `The team “${mutation.args.name}”`;
		case "relation.create":
			return "A relation";
		default:
			return mutation.name;
	}
}

/** "3 issues", "3 issues and 5 comments", or "3 issues, 5 comments and 2 relations". */
function contents(plan: ImportPlan): string {
	const parts = [
		countOf(plan.issues, "issue"),
		plan.comments > 0 && countOf(plan.comments, "comment"),
		plan.relations > 0 && countOf(plan.relations, "relation"),
	].filter((part) => typeof part === "string");
	const last = parts.pop() ?? "";
	return parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
}

function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
