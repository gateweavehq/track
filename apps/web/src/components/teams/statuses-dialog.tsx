import {
	MAX_STATUSES_PER_TEAM,
	mutationSchema,
	STATUS_CATEGORIES,
	type StatusCategory,
	statusKeyFor,
	type Team,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { StatusIcon } from "#/components/issues/meta";
import { Button } from "#/components/ui/button";
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
import { LABEL_COLORS } from "#/lib/labels";
import { send } from "#/lib/mutations";
import { useIssueCountsByStatus, useStatuses, useTeamStatuses } from "#/lib/queries";
import { cannotRemove, defaultMoveTo, moveStatus, sortOrderAtEnd } from "#/lib/statuses";
import { cn } from "#/lib/utils";

const SELECT =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

/** What each category means, since what Track does with a status follows its category. */
const CATEGORIES: Record<StatusCategory, { name: string; hint: string }> = {
	backlog: { name: "Backlog", hint: "Ideas and requests nobody has planned yet." },
	unstarted: { name: "Unstarted", hint: "Planned, but not begun." },
	started: { name: "Started", hint: "Being worked on." },
	completed: {
		name: "Completed",
		hint: "Closes the issue and counts it as done in cycles and projects.",
	},
	canceled: { name: "Canceled", hint: "Closes the issue without counting it as done." },
};

function issueCount(count: number): string {
	return count === 1 ? "1 issue" : `${count} issues`;
}

/**
 * A team's workflow: its statuses by category, in order, to add, rename, recolor, move and
 * remove. Admins only; the server checks again, by the same rules.
 */
export function StatusesDialog({ team, onClose }: { team: Team; onClose: () => void }) {
	const client = useSyncClient();
	const statuses = useTeamStatuses(team.id);
	const counts = useIssueCountsByStatus(team.id);
	const [editing, setEditing] = useState<WorkflowStatus | StatusCategory | null>(null);
	const [removing, setRemoving] = useState<WorkflowStatus | null>(null);
	const full = statuses.length >= MAX_STATUSES_PER_TEAM;

	function move(status: WorkflowStatus, by: -1 | 1) {
		for (const { key, sortOrder } of moveStatus(statuses, status.key, by)) {
			send(client, {
				name: "status.update",
				args: { teamId: team.id, key, patch: { sortOrder } },
			});
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Statuses of {team.name}</DialogTitle>
					<DialogDescription>
						Issues move through these in order. Each status is in a category, which decides what it
						means for cycles, projects and GitHub.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-5">
					{STATUS_CATEGORIES.map((category) => {
						const inCategory = statuses.filter((status) => status.category === category);
						const { name, hint } = CATEGORIES[category];
						return (
							<section key={category} aria-labelledby={`status-category-${category}`}>
								<div className="mb-1.5 flex items-start justify-between gap-3">
									<div className="min-w-0">
										<h3 id={`status-category-${category}`} className="text-sm font-medium">
											{name}
										</h3>
										<p className="text-xs text-muted-foreground">{hint}</p>
									</div>
									<Button
										variant="ghost"
										size="icon"
										className="size-7 shrink-0"
										disabled={full}
										title={
											full ? `A team has at most ${MAX_STATUSES_PER_TEAM} statuses` : undefined
										}
										aria-label={`Add a ${name.toLowerCase()} status`}
										onClick={() => setEditing(category)}
									>
										<Plus />
									</Button>
								</div>
								{inCategory.length === 0 ? (
									<p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
										No {name.toLowerCase()} statuses.
									</p>
								) : (
									<ul className="divide-y rounded-md border">
										{inCategory.map((status, index) => {
											const blocked = cannotRemove(statuses, status.key);
											return (
												<li key={status.id} className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
													<StatusIcon status={status} />
													<span className="min-w-0 flex-1 truncate text-sm">{status.name}</span>
													<span className="text-xs text-muted-foreground tabular-nums">
														{issueCount(counts.get(status.key) ?? 0)}
													</span>
													<div className="flex shrink-0 items-center">
														<Button
															variant="ghost"
															size="icon"
															className="size-7"
															disabled={index === 0}
															aria-label={`Move ${status.name} up`}
															onClick={() => move(status, -1)}
														>
															<ArrowUp />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="size-7"
															disabled={index === inCategory.length - 1}
															aria-label={`Move ${status.name} down`}
															onClick={() => move(status, 1)}
														>
															<ArrowDown />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="size-7"
															aria-label={`Edit ${status.name}`}
															onClick={() => setEditing(status)}
														>
															<Pencil />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															className="size-7"
															disabled={blocked !== null}
															title={blocked ?? undefined}
															aria-label={`Remove ${status.name}`}
															onClick={() => setRemoving(status)}
														>
															<Trash2 />
														</Button>
													</div>
												</li>
											);
										})}
									</ul>
								)}
							</section>
						);
					})}
				</div>
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
				{editing !== null && (
					<StatusFormDialog
						team={team}
						status={typeof editing === "string" ? undefined : editing}
						category={typeof editing === "string" ? editing : editing.category}
						onClose={() => setEditing(null)}
					/>
				)}
				{removing && (
					<RemoveStatusDialog
						team={team}
						status={removing}
						count={counts.get(removing.key) ?? 0}
						onClose={() => setRemoving(null)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Adds a status to a category, or renames, recolors or recategorizes one. */
function StatusFormDialog({
	team,
	status,
	category: initialCategory,
	onClose,
}: {
	team: Team;
	status: WorkflowStatus | undefined;
	category: StatusCategory;
	onClose: () => void;
}) {
	const client = useSyncClient();
	const id = useId();
	const statuses = useTeamStatuses(team.id);
	const all = useStatuses();
	const [name, setName] = useState(status?.name ?? "");
	const [category, setCategory] = useState(initialCategory);
	const [color, setColor] = useState<string | null>(status?.color ?? null);
	const [error, setError] = useState<string | null>(null);
	// Keys are never used twice in a team, so removed statuses' keys are taken too.
	const taken = useMemo(
		() =>
			new Set([...all.values()].filter((item) => item.teamId === team.id).map((item) => item.key)),
		[all, team.id],
	);

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		const others = statuses.filter((item) => item.key !== status?.key);
		const twin = others.find((item) => item.name.toLowerCase() === trimmed.toLowerCase());
		if (twin) {
			setError(`${team.name} already has a status named ${twin.name}`);
			return;
		}
		if (
			status?.category === "completed" &&
			category !== "completed" &&
			!others.some((item) => item.category === "completed")
		) {
			setError("A team needs at least one completed status");
			return;
		}
		const mutation = status
			? {
					name: "status.update" as const,
					args: {
						teamId: team.id,
						key: status.key,
						patch: {
							...(trimmed !== status.name && { name: trimmed }),
							...(color !== status.color && { color }),
							// A status moved to another category goes last there.
							...(category !== status.category && {
								category,
								sortOrder: sortOrderAtEnd(statuses, category, status.key),
							}),
						},
					},
				}
			: {
					name: "status.create" as const,
					args: {
						teamId: team.id,
						key: statusKeyFor(trimmed, taken),
						name: trimmed,
						category,
						color,
						sortOrder: sortOrderAtEnd(statuses, category),
					},
				};
		if (mutation.name === "status.update" && Object.keys(mutation.args.patch).length === 0) {
			onClose();
			return;
		}
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the name");
			return;
		}
		if (send(client, mutation)) onClose();
	}

	const colors: { value: string | null; name: string }[] = [
		{ value: null, name: "Neutral" },
		...LABEL_COLORS,
	];

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{status ? `Edit ${status.name}` : "Add status"}</DialogTitle>
					<DialogDescription>
						{status
							? "Its issues, history and filters keep it under its new name."
							: `A new status for ${team.name}, last in its category.`}
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${id}-name`}>Name</Label>
						<Input
							id={`${id}-name`}
							value={name}
							onChange={(event) => {
								setName(event.target.value);
								setError(null);
							}}
							maxLength={32}
							placeholder="Ready for QA"
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-category`}>Category</Label>
						<select
							id={`${id}-category`}
							value={category}
							onChange={(event) => {
								setCategory(event.target.value as StatusCategory);
								setError(null);
							}}
							className={SELECT}
							aria-describedby={`${id}-category-hint`}
						>
							{STATUS_CATEGORIES.map((option) => (
								<option key={option} value={option}>
									{CATEGORIES[option].name}
								</option>
							))}
						</select>
						<p id={`${id}-category-hint`} className="text-xs text-muted-foreground">
							{CATEGORIES[category].hint}
						</p>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Color</legend>
						<div className="flex flex-wrap gap-2">
							{colors.map((option) => (
								<button
									key={option.name}
									type="button"
									aria-label={option.name}
									aria-pressed={color === option.value}
									onClick={() => setColor(option.value)}
									className={cn(
										"flex size-7 items-center justify-center rounded-full ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
										option.value === null && "border bg-muted",
									)}
									style={option.value === null ? undefined : { backgroundColor: option.value }}
								>
									{color === option.value && (
										<Check
											className={cn(
												"size-4",
												option.value === null ? "text-foreground" : "text-white",
											)}
										/>
									)}
								</button>
							))}
						</div>
					</fieldset>
					<div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
						<StatusIcon
							status={{ key: status?.key ?? "", name: name || "Preview", category, color }}
						/>
						<span className="truncate">{name.trim() || "Preview"}</span>
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
						<Button type="submit" disabled={!name.trim()}>
							{status ? "Save" : "Add status"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Removes a status, moving its issues to another of the team's statuses. */
function RemoveStatusDialog({
	team,
	status,
	count,
	onClose,
}: {
	team: Team;
	status: WorkflowStatus;
	count: number;
	onClose: () => void;
}) {
	const client = useSyncClient();
	const id = useId();
	const statuses = useTeamStatuses(team.id);
	const others = statuses.filter((item) => item.key !== status.key);
	const [moveTo, setMoveTo] = useState(() => defaultMoveTo(statuses, status.key) ?? "");

	function remove() {
		if (!moveTo) return;
		if (
			send(client, { name: "status.delete", args: { teamId: team.id, key: status.key, moveTo } })
		) {
			onClose();
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove {status.name}?</DialogTitle>
					<DialogDescription>
						{count === 0
							? "No issue is in it. History keeps its name."
							: count === 1
								? "Its one issue moves to another status, and history keeps its name."
								: `Its ${count} issues move to another status, and history keeps its name.`}
					</DialogDescription>
				</DialogHeader>
				{count > 0 && (
					<div className="space-y-2">
						<Label htmlFor={`${id}-move`}>Move its issues to</Label>
						<select
							id={`${id}-move`}
							value={moveTo}
							onChange={(event) => setMoveTo(event.target.value)}
							className={SELECT}
						>
							{others.map((option) => (
								<option key={option.key} value={option.key}>
									{option.name}
								</option>
							))}
						</select>
					</div>
				)}
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={remove} disabled={!moveTo}>
						Remove status
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
