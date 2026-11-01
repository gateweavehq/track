import {
	dayIn,
	type IssuePriority,
	type IssueTemplate,
	MAX_LABELS_PER_ISSUE,
	MAX_REPEAT_EVERY,
	MAX_TEMPLATES_PER_TEAM,
	mutationSchema,
	nextRepeatDay,
	REPEAT_UNITS,
	type RepeatUnit,
	type TemplateRepeat,
} from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Plus, Repeat, Tag } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { LabelChips, LabelMenu } from "#/components/issues/labels";
import { PRIORITY_META, PriorityIcon } from "#/components/issues/meta";
import { AssigneePicker, PriorityPicker, TeamPicker } from "#/components/issues/pickers";
import { MemberAvatar } from "#/components/members/member-avatar";
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
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { teamZone, timeZones } from "#/lib/cycles";
import { formatFullDay, formatShortDay } from "#/lib/dates";
import { send } from "#/lib/mutations";
import { useActiveMembers, useMembersById, useTeams, useTemplates } from "#/lib/queries";
import { repeatLabel, sameRepeat } from "#/lib/templates";

const SELECT =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

export function TemplatesSettings() {
	const client = useSyncClient();
	const teams = useTeams();
	const templates = useTemplates();
	const members = useMembersById();
	const [editing, setEditing] = useState<IssueTemplate | "new" | null>(null);
	const [deleting, setDeleting] = useState<IssueTemplate | null>(null);
	const withTemplates = teams.filter((team) =>
		templates.some((template) => template.teamId === team.id),
	);

	return (
		<section aria-labelledby="templates-heading" className="space-y-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
				<div className="space-y-1">
					<h2 id="templates-heading" className="text-base font-semibold">
						Templates
					</h2>
					<p className="text-sm text-muted-foreground">
						A template starts a new issue with a title, description, priority, assignee and labels.
						Each team has its own, and anyone can create and edit them. Give one a schedule, and
						Track creates its issue on its own, such as a weekly report.
					</p>
				</div>
				<Button
					size="sm"
					className="self-start sm:self-auto"
					onClick={() => setEditing("new")}
					disabled={teams.length === 0}
				>
					<Plus />
					Create template
				</Button>
			</div>
			{withTemplates.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					No templates yet. Once a team has one, pick it when you create an issue.
				</p>
			) : (
				withTemplates.map((team) => (
					<div key={team.id} className="space-y-2">
						<h3 className="text-sm font-medium">{team.name}</h3>
						<ul aria-label={`${team.name} templates`} className="divide-y rounded-lg border">
							{templates
								.filter((template) => template.teamId === team.id)
								.map((template) => {
									const assignee = template.assigneeId
										? members.get(template.assigneeId)
										: undefined;
									return (
										<li
											key={template.id}
											className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
										>
											<div className="min-w-24 flex-1 space-y-0.5">
												<p className="truncate text-sm font-medium">{template.name}</p>
												{template.title.trim() && (
													<p className="truncate text-xs text-muted-foreground">{template.title}</p>
												)}
											</div>
											{template.priority !== 0 && (
												<span title={PRIORITY_META[template.priority].label}>
													<PriorityIcon priority={template.priority} />
												</span>
											)}
											{assignee && assignee.removedAt === null && (
												<MemberAvatar member={assignee} className="size-5" />
											)}
											<LabelChips labelIds={template.labelIds} max={2} />
											{template.repeat && (
												<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
													<Repeat aria-hidden className="size-3.5" />
													{repeatLabel(template.repeat)}
													{template.nextOn && `, next ${formatShortDay(template.nextOn)}`}
												</span>
											)}
											<div className="-mr-2 ml-auto flex shrink-0">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setEditing(template)}
													aria-label={`Edit ${template.name}`}
												>
													Edit
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setDeleting(template)}
													aria-label={`Delete ${template.name}`}
												>
													Delete
												</Button>
											</div>
										</li>
									);
								})}
						</ul>
					</div>
				))
			)}
			{editing && (
				<TemplateDialog
					template={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title={`Delete ${deleting.name}?`}
					confirmLabel="Delete template"
					onConfirm={() => {
						send(client, { name: "template.delete", args: { id: deleting.id } });
					}}
					onClose={() => setDeleting(null)}
				>
					Issues made from it stay as they are.
				</ConfirmDialog>
			)}
		</section>
	);
}

/** Creates a template, or changes one. The server checks the name and the rest again. */
function TemplateDialog({
	template,
	onClose,
}: {
	template: IssueTemplate | undefined;
	onClose: () => void;
}) {
	const client = useSyncClient();
	const id = useId();
	const teams = useTeams();
	const templates = useTemplates();
	const members = useActiveMembers();
	const [teamId, setTeamId] = useState(template?.teamId ?? teams[0]?.id ?? "");
	const [name, setName] = useState(template?.name ?? "");
	const [title, setTitle] = useState(template?.title ?? "");
	const [description, setDescription] = useState(template?.description ?? "");
	const [priority, setPriority] = useState<IssuePriority>(template?.priority ?? 0);
	// Someone who has left cannot be assigned, so the template shows no one for them.
	const [assigneeId, setAssigneeId] = useState<string | null>(() => {
		const wanted = template?.assigneeId;
		return wanted && members.some((member) => member.id === wanted) ? wanted : null;
	});
	const [labelIds, setLabelIds] = useState<string[]>(() => {
		const known = client.getState().labels;
		return (template?.labelIds ?? []).filter((labelId) => known.has(labelId));
	});
	const [repeats, setRepeats] = useState(template?.repeat != null);
	const [every, setEvery] = useState(String(template?.repeat?.every ?? 1));
	const [unit, setUnit] = useState<RepeatUnit>(template?.repeat?.unit ?? "week");
	const [timeZone, setTimeZone] = useState(
		() => template?.repeat?.timeZone ?? teamZone(teams.find((each) => each.id === teamId)),
	);
	const [startsOn, setStartsOn] = useState(
		() => template?.repeat?.startsOn ?? dayIn(timeZone, Date.now()),
	);
	const [error, setError] = useState<string | null>(null);
	const zones = useMemo(() => timeZones(timeZone), [timeZone]);
	const team = teams.find((each) => each.id === teamId);
	const assignee = members.find((member) => member.id === assigneeId);
	const repeat: TemplateRepeat | null = repeats
		? { every: Number(every), unit, startsOn, timeZone }
		: null;
	const firstOn = repeat && scheduleDay(repeat);

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const folded = name.trim().toLowerCase();
		const siblings = templates.filter(
			(other) => other.teamId === teamId && other.id !== template?.id,
		);
		if (siblings.some((other) => other.name.toLowerCase() === folded)) {
			setError(`${team?.name ?? "The team"} already has a template named ${name.trim()}`);
			return;
		}
		if (!template && siblings.length >= MAX_TEMPLATES_PER_TEAM) {
			setError(`A team holds at most ${MAX_TEMPLATES_PER_TEAM} templates`);
			return;
		}
		if (repeat && !title.trim()) {
			setError("A template that repeats needs an issue title");
			return;
		}
		const fields = {
			name,
			title,
			description: description.trim() ? description : null,
			priority,
			assigneeId,
			labelIds,
			repeat,
		};
		const mutation = template
			? {
					name: "template.update" as const,
					args: { id: template.id, patch: changedFields(template, fields) },
				}
			: { name: "template.create" as const, args: { id: uuidv7(), teamId, ...fields } };
		if (mutation.name === "template.update" && Object.keys(mutation.args.patch).length === 0) {
			onClose();
			return;
		}
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the template");
			return;
		}
		if (send(client, mutation)) onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{template ? `Edit ${template.name}` : "Create template"}</DialogTitle>
					<DialogDescription>
						New issues made from it start with these. Whoever creates the issue can still change
						them.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-[1fr_auto]">
						<div className="space-y-2">
							<Label htmlFor={`${id}-name`}>Name</Label>
							<Input
								id={`${id}-name`}
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									setError(null);
								}}
								maxLength={64}
								placeholder="Bug report"
								required
							/>
						</div>
						<div className="space-y-2">
							<span className="block text-sm font-medium">Team</span>
							{template ? (
								<p className="flex h-9 items-center text-sm">{team?.name}</p>
							) : (
								<TeamPicker teams={teams} value={teamId} onChange={setTeamId}>
									<Button type="button" variant="outline" className="w-full justify-start sm:w-40">
										<span className="font-mono text-xs text-muted-foreground">{team?.key}</span>
										<span className="truncate">{team?.name ?? "Team"}</span>
									</Button>
								</TeamPicker>
							)}
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-title`}>Issue title</Label>
						<Input
							id={`${id}-title`}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							maxLength={512}
							placeholder="Bug: "
							aria-describedby={`${id}-title-hint`}
						/>
						<p id={`${id}-title-hint`} className="text-xs text-muted-foreground">
							{repeats
								? "The title of each issue it creates."
								: 'Optional. A start such as "Bug: " is kept as written.'}
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-description`}>Description</Label>
						<Textarea
							id={`${id}-description`}
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							rows={5}
							maxLength={100_000}
							placeholder={"## Steps to reproduce\n\n## Expected"}
						/>
					</div>
					<div className="flex flex-wrap gap-2">
						<PriorityPicker value={priority} onChange={setPriority}>
							<Button type="button" variant="outline" size="sm" aria-label="Priority">
								<PriorityIcon priority={priority} />
								{priority === 0 ? "No priority" : PRIORITY_META[priority].label}
							</Button>
						</PriorityPicker>
						<AssigneePicker value={assigneeId} onChange={setAssigneeId}>
							<Button type="button" variant="outline" size="sm" aria-label="Assignee">
								<MemberAvatar member={assignee} className="size-4" />
								{assignee?.name ?? "No assignee"}
							</Button>
						</AssigneePicker>
						<LabelMenu
							selected={labelIds}
							creatable
							onToggle={(labelId) =>
								setLabelIds((ids) =>
									ids.includes(labelId)
										? ids.filter((other) => other !== labelId)
										: ids.length < MAX_LABELS_PER_ISSUE
											? [...ids, labelId]
											: ids,
								)
							}
						>
							<Button type="button" variant="outline" size="sm" aria-label="Labels">
								{labelIds.length > 0 ? (
									<LabelChips labelIds={labelIds} max={3} />
								) : (
									<>
										<Tag />
										Labels
									</>
								)}
							</Button>
						</LabelMenu>
					</div>
					<fieldset className="space-y-3">
						<legend className="sr-only">Schedule</legend>
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${id}-repeats`}
								checked={repeats}
								onCheckedChange={(checked) => {
									setRepeats(checked === true);
									setError(null);
								}}
							/>
							<Label htmlFor={`${id}-repeats`}>Create an issue on a schedule</Label>
						</div>
						{repeats && (
							<>
								<div className="grid grid-cols-[5rem_1fr] gap-3 sm:grid-cols-[5rem_1fr_1fr]">
									<div className="space-y-2">
										<Label htmlFor={`${id}-every`}>Every</Label>
										<Input
											id={`${id}-every`}
											type="number"
											inputMode="numeric"
											min={1}
											max={MAX_REPEAT_EVERY}
											value={every}
											onChange={(event) => {
												setEvery(event.target.value);
												setError(null);
											}}
											required
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor={`${id}-unit`}>Unit</Label>
										<select
											id={`${id}-unit`}
											value={unit}
											onChange={(event) => setUnit(event.target.value as RepeatUnit)}
											className={SELECT}
										>
											{REPEAT_UNITS.map((each) => (
												<option key={each} value={each}>
													{every === "1" ? each : `${each}s`}
												</option>
											))}
										</select>
									</div>
									<div className="col-span-2 space-y-2 sm:col-span-1">
										<Label htmlFor={`${id}-starts`}>Starting</Label>
										<Input
											id={`${id}-starts`}
											type="date"
											value={startsOn}
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
									>
										{zones.map((zone) => (
											<option key={zone} value={zone}>
												{zone.replaceAll("_", " ")}
											</option>
										))}
									</select>
								</div>
								{repeat && firstOn && (
									<p className="text-sm text-muted-foreground">
										{repeatLabel(repeat)}, Track creates an issue at midnight in this time zone. The
										next is on {formatFullDay(firstOn)}.
									</p>
								)}
							</>
						)}
					</fieldset>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!name.trim() || !team}>
							{template ? "Save" : "Create template"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type TemplateFields = Pick<
	IssueTemplate,
	"name" | "title" | "description" | "priority" | "assigneeId" | "labelIds" | "repeat"
>;

/** The day a schedule's next issue comes, or null while what was typed is not yet a schedule. */
function scheduleDay(repeat: TemplateRepeat): string | null {
	const { every, startsOn } = repeat;
	if (!Number.isInteger(every) || every < 1 || every > MAX_REPEAT_EVERY) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return null;
	return nextRepeatDay(repeat, dayIn(repeat.timeZone, Date.now()));
}

/** Only what changed, so an edit made elsewhere to another field is not undone. */
function changedFields(template: IssueTemplate, fields: TemplateFields): Partial<TemplateFields> {
	const sameLabels =
		template.labelIds.length === fields.labelIds.length &&
		template.labelIds.every((labelId, index) => fields.labelIds[index] === labelId);
	return {
		...(fields.name.trim() !== template.name && { name: fields.name }),
		...(fields.title !== template.title && { title: fields.title }),
		...(fields.description !== template.description && { description: fields.description }),
		...(fields.priority !== template.priority && { priority: fields.priority }),
		...(fields.assigneeId !== template.assigneeId && { assigneeId: fields.assigneeId }),
		...(!sameLabels && { labelIds: fields.labelIds }),
		...(!sameRepeat(template.repeat, fields.repeat) && { repeat: fields.repeat }),
	};
}
