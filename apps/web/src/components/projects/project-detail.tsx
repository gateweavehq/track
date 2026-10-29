import type { MutationInput, Project } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useNavigate } from "@tanstack/react-router";
import { Trash, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LeadPicker, ProjectStatusPicker } from "#/components/issues/pickers";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { send } from "#/lib/mutations";
import { formatTargetDate, isOverdue, progressPercent, projectProgress } from "#/lib/projects";
import { useMembersById, useProjectIssues } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { PROJECT_STATUS_META, ProjectStatusIcon } from "./meta";

type ProjectPatch = Extract<MutationInput, { name: "project.update" }>["args"]["patch"];

function useUpdateProject(project: Project) {
	const client = useSyncClient();
	return useCallback(
		(patch: ProjectPatch) =>
			send(client, { name: "project.update", args: { id: project.id, patch } }),
		[client, project.id],
	);
}

/**
 * The project's own fields, edited in place: name, description, status, lead and target date.
 * Text is kept local while the user types, so changes from others do not overwrite it, and saved
 * when the field loses focus (the description also after a pause). Projects have no versions, so
 * the last edit wins.
 */
export function ProjectDetails({ project }: { project: Project }) {
	const update = useUpdateProject(project);
	const members = useMembersById();
	const lead = project.leadId ? members.get(project.leadId) : undefined;
	const progress = projectProgress(useProjectIssues(project.id));
	const percent = progressPercent(progress);
	const overdue = isOverdue(project);

	return (
		<section aria-label="Project details" className="space-y-4 border-b px-4 py-6 sm:px-6">
			<TextField
				value={project.name}
				onSave={(name) => name.trim() && update({ name: name.trim() })}
				label="Name"
				singleLine
				maxLength={64}
				className="text-2xl font-semibold tracking-tight"
			/>
			<div className="flex flex-wrap items-center gap-2">
				<ProjectStatusPicker value={project.status} onChange={(status) => update({ status })}>
					<Button variant="outline" size="sm" className="h-8 px-2">
						<ProjectStatusIcon status={project.status} />
						{PROJECT_STATUS_META[project.status].label}
					</Button>
				</ProjectStatusPicker>
				<LeadPicker value={project.leadId} onChange={(leadId) => update({ leadId })}>
					<Button variant="outline" size="sm" className="h-8 px-2">
						<MemberAvatar member={lead} className="size-4" />
						{lead?.name ?? "No lead"}
					</Button>
				</LeadPicker>
				<TargetDate project={project} onChange={(targetDate) => update({ targetDate })} />
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
					<span className="tabular-nums">
						{progress.done}/{progress.total} done
					</span>
				</div>
			</div>
			{overdue && project.targetDate && (
				<p className="text-xs text-destructive">
					Past its target date, {formatTargetDate(project.targetDate)}.
				</p>
			)}
			<TextField
				value={project.description ?? ""}
				onSave={(description) => update({ description: description.trim() ? description : null })}
				label="Description"
				placeholder="Add a description…"
				maxLength={100_000}
				idleMs={1000}
				className="min-h-16 text-sm leading-relaxed"
			/>
		</section>
	);
}

function TargetDate({
	project,
	onChange,
}: {
	project: Project;
	onChange: (targetDate: string | null) => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<Input
				type="date"
				value={project.targetDate ?? ""}
				onChange={(event) => onChange(event.target.value || null)}
				aria-label="Target date"
				className={cn("h-8 w-40", isOverdue(project) && "text-destructive")}
			/>
			{project.targetDate && (
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					aria-label="Clear the target date"
					onClick={() => onChange(null)}
				>
					<X />
				</Button>
			)}
		</div>
	);
}

/**
 * Text that is edited in place. While focused it shows the user's own text; on blur (or after
 * `idleMs` without typing, and on the way out of the page) it is saved if it changed. Escape
 * throws the edit away, and Enter saves a single-line field.
 */
function TextField({
	value,
	onSave,
	label,
	placeholder,
	maxLength,
	className,
	singleLine = false,
	idleMs,
}: {
	value: string;
	onSave: (next: string) => unknown;
	label: string;
	placeholder?: string;
	maxLength: number;
	className?: string;
	singleLine?: boolean;
	idleMs?: number;
}) {
	const [draft, setDraftState] = useState<string | null>(null);
	// Event handlers read the draft from a ref: blur can follow a cancel before React re-renders.
	const draftRef = useRef<string | null>(null);
	const latest = useRef({ value, onSave });
	latest.current = { value, onSave };

	const setDraft = (next: string | null) => {
		draftRef.current = next;
		setDraftState(next);
	};
	const flush = useCallback(() => {
		const current = draftRef.current;
		if (current !== null && current !== latest.current.value) latest.current.onSave(current);
	}, []);

	useEffect(() => {
		if (draft === null || idleMs === undefined) return;
		const timer = setTimeout(flush, idleMs);
		return () => clearTimeout(timer);
	}, [draft, idleMs, flush]);
	// Leaving the page does not blur the field, so save what was typed on the way out.
	useEffect(() => flush, [flush]);

	return (
		<textarea
			value={draft ?? value}
			onFocus={() => {
				if (draftRef.current === null) setDraft(latest.current.value);
			}}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				flush();
				setDraft(null);
			}}
			onKeyDown={(event) => {
				if (singleLine && event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					setDraft(null);
					event.currentTarget.blur();
				}
			}}
			aria-label={label}
			placeholder={placeholder}
			rows={singleLine ? 1 : undefined}
			maxLength={maxLength}
			className={cn(
				"field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground",
				className,
			)}
		/>
	);
}

/** Admins delete a project. Its issues stay, without a project. */
export function DeleteProjectButton({
	project,
	issueCount,
}: {
	project: Project;
	issueCount: number;
}) {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const [confirming, setConfirming] = useState(false);
	const admin = isAdmin(useMyRole());
	if (!admin) return null;

	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="size-8"
				aria-label="Delete project"
				onClick={() => setConfirming(true)}
			>
				<Trash />
			</Button>
			{confirming && (
				<ConfirmDialog
					title={`Delete ${project.name}?`}
					confirmLabel="Delete project"
					onConfirm={() => {
						if (send(client, { name: "project.delete", args: { id: project.id } })) {
							void navigate({
								to: "/$workspace/projects",
								params: { workspace: slug },
								replace: true,
							});
						}
					}}
					onClose={() => setConfirming(false)}
				>
					{issueCount === 0
						? "The project will be deleted for everyone in the workspace."
						: `The project will be deleted for everyone in the workspace. Its ${issueCount === 1 ? "issue stays" : `${issueCount} issues stay`}, without a project.`}
				</ConfirmDialog>
			)}
		</>
	);
}
