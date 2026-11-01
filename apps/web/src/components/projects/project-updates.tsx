import {
	PROJECT_HEALTHS,
	type Project,
	type ProjectHealth,
	type ProjectUpdate,
} from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { CircleUserRound, Ellipsis, Plus } from "lucide-react";
import { useId, useState } from "react";
import { Markdown } from "#/components/markdown";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Kbd } from "#/components/ui/kbd";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { MOD_LABEL } from "#/lib/hotkeys";
import { send } from "#/lib/mutations";
import { useMembersById, useProjectUpdates } from "#/lib/queries";
import { cn } from "#/lib/utils";
import { HEALTH_META, ProjectHealthBadge } from "./meta";

/**
 * A project's updates: how it is going, as people (and agents) post it. The latest says how it
 * is going now; the earlier ones are its history, a click away.
 */
export function ProjectUpdates({ project }: { project: Project }) {
	const client = useSyncClient();
	const updates = useProjectUpdates(project.id);
	const [posting, setPosting] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [latest, ...earlier] = updates;
	const headingId = useId();

	return (
		<section aria-labelledby={headingId} className="space-y-3 border-b px-4 py-4 sm:px-6">
			<div className="flex items-center gap-2">
				<h2 id={headingId} className="text-sm font-medium">
					Updates
				</h2>
				{latest && <ProjectHealthBadge health={latest.health} />}
				{!posting && (
					<Button
						variant="outline"
						size="sm"
						className="ml-auto h-7"
						onClick={() => setPosting(true)}
					>
						<Plus />
						Post update
					</Button>
				)}
			</div>
			{posting && (
				<UpdateForm
					initialHealth={latest?.health ?? "on_track"}
					submitLabel="Post update"
					autoFocus
					onCancel={() => setPosting(false)}
					onSubmit={(health, body) => {
						const sent = send(client, {
							name: "projectUpdate.create",
							args: { id: uuidv7(), projectId: project.id, health, body },
						});
						if (sent) setPosting(false);
						return sent;
					}}
				/>
			)}
			{latest ? (
				<ol aria-label={`${project.name} updates`} className="space-y-2">
					{(showAll ? updates : [latest]).map((update) => (
						<li key={update.id}>
							<UpdateItem update={update} />
						</li>
					))}
				</ol>
			) : (
				!posting && (
					<p className="text-sm text-muted-foreground">
						No updates yet. Post one to say whether the project is on track, and why.
					</p>
				)
			)}
			{earlier.length > 0 && (
				<Button
					variant="link"
					size="sm"
					className="h-auto p-0 text-muted-foreground"
					aria-expanded={showAll}
					onClick={() => setShowAll((shown) => !shown)}
				>
					{showAll
						? "Show the latest only"
						: `Show ${earlier.length} earlier ${earlier.length === 1 ? "update" : "updates"}`}
				</Button>
			)}
		</section>
	);
}

function UpdateItem({ update }: { update: ProjectUpdate }) {
	const client = useSyncClient();
	const { userId } = useWorkspace();
	const role = useMyRole();
	const author = useMembersById().get(update.authorId);
	const [editing, setEditing] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const mine = update.authorId === userId;
	const canDelete = mine || isAdmin(role);
	const name = author?.name ?? "Someone";

	return (
		<article
			aria-label={`Update by ${name}`}
			className="rounded-lg border bg-card px-3 py-2.5 text-card-foreground"
		>
			<header className="flex flex-wrap items-center gap-2 text-xs">
				{author ? (
					<MemberAvatar member={author} className="size-5" />
				) : (
					<CircleUserRound aria-hidden className="size-5 text-muted-foreground" />
				)}
				<span className="font-medium">{name}</span>
				<ProjectHealthBadge health={update.health} />
				<time
					dateTime={new Date(update.createdAt).toISOString()}
					title={formatDateTime(update.createdAt)}
					className="text-muted-foreground"
				>
					{formatRelative(update.createdAt)}
				</time>
				{update.updatedAt > update.createdAt && (
					<span className="text-muted-foreground" title={formatDateTime(update.updatedAt)}>
						(edited)
					</span>
				)}
				{canDelete && !editing && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="ml-auto size-6"
								aria-label={`More for the update by ${name}`}
							>
								<Ellipsis />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{mine && <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>}
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onSelect={() => setConfirmDelete(true)}
							>
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</header>
			{editing ? (
				<UpdateForm
					initialHealth={update.health}
					initialBody={update.body}
					submitLabel="Save"
					autoFocus
					onCancel={() => setEditing(false)}
					onSubmit={(health, body) => {
						const patch = {
							...(health !== update.health && { health }),
							...(body !== update.body && { body }),
						};
						if (Object.keys(patch).length > 0) {
							send(client, { name: "projectUpdate.update", args: { id: update.id, patch } });
						}
						setEditing(false);
						return true;
					}}
				/>
			) : (
				<Markdown source={update.body} className="mt-1.5" />
			)}
			{confirmDelete && (
				<ConfirmDialog
					title="Delete update?"
					confirmLabel="Delete update"
					onConfirm={() => {
						send(client, { name: "projectUpdate.delete", args: { id: update.id } });
					}}
					onClose={() => setConfirmDelete(false)}
				>
					It will be deleted for everyone in the workspace.
				</ConfirmDialog>
			)}
		</article>
	);
}

/** The health and the text. `onSubmit` gets trimmed text and returns whether it was sent. */
function UpdateForm({
	initialHealth,
	initialBody = "",
	submitLabel,
	autoFocus,
	onSubmit,
	onCancel,
}: {
	initialHealth: ProjectHealth;
	initialBody?: string;
	submitLabel: string;
	autoFocus?: boolean;
	onSubmit: (health: ProjectHealth, body: string) => boolean;
	onCancel: () => void;
}) {
	const [health, setHealth] = useState(initialHealth);
	const [body, setBody] = useState(initialBody);
	const group = useId();
	const empty = !body.trim();

	function submit() {
		if (!empty) onSubmit(health, body.trim());
	}

	return (
		<form
			className="space-y-2"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="sr-only">Health</legend>
				{PROJECT_HEALTHS.map((option) => {
					const { label, icon: Icon, className } = HEALTH_META[option];
					return (
						<label
							key={option}
							className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs has-[:checked]:border-foreground has-[:checked]:bg-muted has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring"
						>
							<input
								type="radio"
								name={group}
								value={option}
								checked={health === option}
								onChange={() => setHealth(option)}
								className="sr-only"
							/>
							<Icon aria-hidden className={cn("size-3.5", className)} />
							{label}
						</label>
					);
				})}
			</fieldset>
			<Textarea
				value={body}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						submit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				aria-label="Update"
				placeholder="What happened, what's next, and what's in the way…"
				autoFocus={autoFocus}
				maxLength={100_000}
				className="field-sizing-content min-h-20 resize-none"
			/>
			<div className="flex items-center justify-end gap-2">
				<span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
					<Kbd>{MOD_LABEL}</Kbd>
					<Kbd>Enter</Kbd>
				</span>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={empty}>
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}
