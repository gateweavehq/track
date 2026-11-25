import {
	type ActiveIssue,
	WORK_RUN_EXECUTORS,
	type WorkRunExecutor,
} from "@gateweave/track-protocol";
import { Link } from "@tanstack/react-router";
import {
	type FormEvent,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import { toast } from "sonner";
import { selectClass } from "#/components/settings/source-form";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { useWorkspace } from "#/components/workspace/context";
import { useRunnerSources, useSource } from "#/lib/queries";
import {
	approveWorkRun,
	normalizeRepository,
	readApproval,
	WORK_RUN_EXECUTOR_LABELS,
	type WorkRunApproval,
} from "#/lib/work-runs";

type Loaded =
	| { status: "loading" }
	| { status: "failed"; message: string }
	| { status: "ready"; approval: WorkRunApproval | null };

/**
 * Whether the assigned runner may take this issue's work, and where it goes (WEB-87). A runner
 * claims only an assignment an owner or admin approved, so the row asks Track, and an admin
 * approves here instead of posting to the work-run gateway by hand. Mount it again (a new `key`)
 * when the assignee changes: a new assignment starts unapproved.
 */
export function RunnerApproval({
	issue,
	issueKey,
	children,
}: {
	issue: ActiveIssue;
	issueKey: string;
	/** The property's trigger, given what the row says. */
	children: (summary: ReactNode) => ReactElement;
}) {
	const { slug } = useWorkspace();
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [open, setOpen] = useState(false);

	// Asks Track once on mount, and again after a failed read. The cleanup drops a late answer.
	const load = useCallback(() => {
		let current = true;
		void readApproval(slug, issueKey).then((answer) => {
			if (!current) return;
			setLoaded(
				answer.ok
					? { status: "ready", approval: answer.approval }
					: { status: "failed", message: answer.message },
			);
		});
		return () => {
			current = false;
		};
	}, [slug, issueKey]);
	useEffect(load, [load]);

	const summary =
		loaded.status === "loading" ? (
			<span className="text-muted-foreground">Checking…</span>
		) : loaded.status === "failed" ? (
			<span className="text-muted-foreground">Could not check</span>
		) : loaded.approval ? (
			<span className="truncate">
				{WORK_RUN_EXECUTOR_LABELS[loaded.approval.executor]} · {loaded.approval.repository}
			</span>
		) : (
			<span className="text-muted-foreground">Not approved</span>
		);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{children(summary)}</PopoverTrigger>
			<PopoverContent className="w-80 space-y-3 p-3 text-sm" aria-label="Runner approval">
				{loaded.status === "loading" && <p className="text-muted-foreground">Checking…</p>}
				{loaded.status === "failed" && (
					<div className="space-y-2">
						<p role="alert" className="text-destructive">
							{loaded.message}
						</p>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setLoaded({ status: "loading" });
								load();
							}}
						>
							Try again
						</Button>
					</div>
				)}
				{loaded.status === "ready" &&
					(loaded.approval ? (
						<ApprovalDetails approval={loaded.approval} />
					) : (
						<ApprovalForm
							issue={issue}
							issueKey={issueKey}
							approved={(approval) => {
								setLoaded({ status: "ready", approval });
								setOpen(false);
								toast.success(`${issueKey} is approved for the runner`);
							}}
						/>
					))}
			</PopoverContent>
		</Popover>
	);
}

function ApprovalDetails({ approval }: { approval: WorkRunApproval }) {
	const source = useSource(approval.sourceId);
	const last = approval.activeAttemptId
		? "An attempt is under way"
		: approval.lastAttemptState
			? `The last attempt ${pastTense(approval.lastAttemptState)}`
			: "No attempt yet";
	return (
		<div className="space-y-2">
			<p className="font-medium">Approved for this assignment</p>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
				<dt className="text-muted-foreground">Repository</dt>
				<dd className="truncate font-mono text-xs leading-5">{approval.repository}</dd>
				<dt className="text-muted-foreground">Runs on</dt>
				<dd>{WORK_RUN_EXECUTOR_LABELS[approval.executor]}</dd>
				<dt className="text-muted-foreground">Reports to</dt>
				<dd className="truncate">{source?.name ?? "A removed source"}</dd>
			</dl>
			<p className="text-muted-foreground">{last}.</p>
			<p className="text-xs text-muted-foreground">
				To send this issue somewhere else, reassign it and approve the new assignment.
			</p>
		</div>
	);
}

function ApprovalForm({
	issue,
	issueKey,
	approved,
}: {
	issue: ActiveIssue;
	issueKey: string;
	approved: (approval: WorkRunApproval) => void;
}) {
	const { slug } = useWorkspace();
	const sources = useRunnerSources(issue.teamId);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	if (sources.length === 0)
		return (
			<p className="text-muted-foreground">
				A runner reports its work to an Agents source of this team. Add one in{" "}
				<Link
					to="/$workspace/settings/sources"
					params={{ workspace: slug }}
					className="text-foreground underline underline-offset-2"
				>
					Sources
				</Link>
				, then approve the work here.
			</p>
		);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		const repository = normalizeRepository(String(data.get("repository") ?? ""));
		if (!repository) {
			setProblem("Name a GitHub repository as owner/repo.");
			return;
		}
		const executor = String(data.get("executor")) as WorkRunExecutor;
		setBusy(true);
		setProblem(null);
		const answer = await approveWorkRun(slug, issueKey, {
			repository,
			sourceId: String(data.get("sourceId")),
			executor: WORK_RUN_EXECUTORS.includes(executor) ? executor : "local-runner",
		});
		setBusy(false);
		if (answer.ok && answer.approval) approved(answer.approval);
		else setProblem(answer.ok ? "Track could not answer. Try again." : answer.message);
	}

	return (
		<form onSubmit={submit} className="space-y-3">
			<p className="text-muted-foreground">
				The assigned agent's runner may take this issue's work once you approve it.
			</p>
			<fieldset disabled={busy} className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="runner-repository">Repository</Label>
					<Input
						id="runner-repository"
						name="repository"
						placeholder="owner/repo"
						autoComplete="off"
						spellCheck={false}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="runner-source">Reports to</Label>
					<select id="runner-source" name="sourceId" className={selectClass}>
						{sources.map((source) => (
							<option key={source.id} value={source.id}>
								{source.name}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="runner-executor">Runs on</Label>
					<select id="runner-executor" name="executor" className={selectClass}>
						{WORK_RUN_EXECUTORS.map((executor) => (
							<option key={executor} value={executor}>
								{WORK_RUN_EXECUTOR_LABELS[executor]}
							</option>
						))}
					</select>
				</div>
				{problem && (
					<p role="alert" className="text-destructive">
						{problem}
					</p>
				)}
				<Button type="submit" size="sm" className="w-full">
					{busy ? "Approving…" : "Approve"}
				</Button>
			</fieldset>
		</form>
	);
}

function pastTense(state: NonNullable<WorkRunApproval["lastAttemptState"]>): string {
	return state === "queued" || state === "running" ? `is ${state}` : state;
}
