import type { IssueDisplay, IssueFilters, IssueLayout, SavedView } from "@gateweave/track-protocol";
import { displayToStore, mutationSchema } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useNavigate } from "@tanstack/react-router";
import { Bookmark, ChevronDown, Lock, Pencil, Share2, Trash, Undo2, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { compactFilters } from "#/lib/filters";
import { send } from "#/lib/mutations";

/** Saves filters, a layout and display options as a new view, then opens it. */
function useCreateView() {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	return (view: {
		name: string;
		personal: boolean;
		layout: IssueLayout;
		filters: IssueFilters;
		display: IssueDisplay;
	}) => {
		const id = uuidv7();
		const sent = send(client, {
			name: "view.create",
			args: {
				id,
				...view,
				filters: compactFilters(view.filters),
				display: displayToStore(view.display),
			},
		});
		if (sent)
			void navigate({ to: "/$workspace/view/$viewId", params: { workspace: slug, viewId: id } });
	};
}

/**
 * Asks for a view's name and who sees it. Saving a new view and renaming one both use it; who
 * sees it is offered only when it is being made.
 */
function ViewNameDialog({
	title,
	description,
	submitLabel,
	initialName = "",
	askPersonal,
	onSubmit,
	onClose,
}: {
	title: string;
	description: string;
	submitLabel: string;
	initialName?: string;
	askPersonal: boolean;
	onSubmit: (name: string, personal: boolean) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState(initialName);
	const [personal, setPersonal] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function submit(event: FormEvent) {
		event.preventDefault();
		const parsed = mutationSchema.safeParse({
			name: "view.update",
			args: { id: "check", patch: { name } },
		});
		if (!parsed.success) {
			setError("A view's name takes 1 to 80 characters");
			return;
		}
		onSubmit(name.trim(), personal);
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="view-name">Name</Label>
						<Input
							id="view-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Urgent bugs"
							maxLength={80}
							autoFocus
							required
						/>
					</div>
					{askPersonal && (
						<div className="flex items-start gap-2">
							<Checkbox
								id="view-personal"
								checked={personal}
								onCheckedChange={(checked) => setPersonal(checked === true)}
								aria-describedby="view-personal-hint"
							/>
							<div className="grid gap-1">
								<Label htmlFor="view-personal">Only for me</Label>
								<p id="view-personal-hint" className="text-xs text-muted-foreground">
									Others in the workspace will not see it in their sidebar. Leave it unticked to
									share it with everyone.
								</p>
							</div>
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" disabled={!name.trim()}>
						{submitLabel}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * "Save view" beside the filters of a page of issues: keeps them, the layout and the display
 * options as a view.
 */
export function SaveViewButton({
	filters,
	layout,
	display,
}: {
	filters: IssueFilters;
	layout: IssueLayout;
	display: IssueDisplay;
}) {
	const [open, setOpen] = useState(false);
	const create = useCreateView();
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="h-6 gap-1 px-2 text-xs"
				onClick={() => setOpen(true)}
			>
				<Bookmark className="size-3" />
				Save view
			</Button>
			{open && (
				<ViewNameDialog
					title="Save view"
					description="Keeps these filters, this layout and these display options under a name in the sidebar."
					submitLabel="Save view"
					askPersonal
					onSubmit={(name, personal) => create({ name, personal, layout, filters, display })}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

/**
 * What a view page shows beside its filters once they, the layout or the display options differ
 * from the saved view:
 * save them into it (for those who may), save them as a new view, or go back to the saved ones.
 */
export function ViewChanges({
	view,
	filters,
	layout,
	display,
	canEdit,
	onSaved,
	onReset,
}: {
	view: SavedView;
	filters: IssueFilters;
	layout: IssueLayout;
	display: IssueDisplay;
	canEdit: boolean;
	onSaved: () => void;
	onReset: () => void;
}) {
	const client = useSyncClient();
	const create = useCreateView();
	const [naming, setNaming] = useState(false);
	return (
		<>
			<span className="text-xs text-muted-foreground">Unsaved changes</span>
			<Button
				variant="ghost"
				size="sm"
				className="h-6 gap-1 px-2 text-xs"
				onClick={onReset}
				aria-label="Discard the changes"
				title="Back to the saved view"
			>
				<Undo2 className="size-3" />
				Reset
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="h-6 px-2 text-xs"
				onClick={() => setNaming(true)}
			>
				Save as new
			</Button>
			{canEdit && (
				<Button
					size="sm"
					className="h-6 px-2 text-xs"
					onClick={() => {
						const sent = send(client, {
							name: "view.update",
							args: {
								id: view.id,
								patch: {
									layout,
									filters: compactFilters(filters),
									display: displayToStore(display),
								},
							},
						});
						if (sent) onSaved();
					}}
				>
					Save
				</Button>
			)}
			{naming && (
				<ViewNameDialog
					title="Save as a new view"
					description={`A new view with these filters, this layout and these display options. "${view.name}" stays as it is.`}
					submitLabel="Save view"
					askPersonal
					onSubmit={(name, personal) => create({ name, personal, layout, filters, display })}
					onClose={() => setNaming(false)}
				/>
			)}
		</>
	);
}

/**
 * Who sees a view, as a button beside its title, with a menu to rename, share or keep it, and
 * delete it, for those who may change it.
 */
export function ViewMenu({ view, canEdit }: { view: SavedView; canEdit: boolean }) {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
	const personal = view.ownerId !== null;
	const label = personal ? "Personal" : "Shared";

	// On a phone the header has little room for the title, so the word goes to screen readers.
	const badge = (
		<span className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground sm:py-0">
			{personal ? (
				<Lock aria-hidden className="size-3" />
			) : (
				<Users aria-hidden className="size-3" />
			)}
			<span className="max-sm:sr-only">{label}</span>
		</span>
	);
	if (!canEdit) return badge;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label={`${label} view options`}
						className="flex items-center gap-0.5 rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						{badge}
						<ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem onSelect={() => setDialog("rename")}>
						<Pencil className="size-4" />
						Rename
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							send(client, {
								name: "view.update",
								args: { id: view.id, patch: { personal: !personal } },
							})
						}
					>
						{personal ? <Share2 className="size-4" /> : <Lock className="size-4" />}
						{personal ? "Share with the workspace" : "Make it personal"}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() => setDialog("delete")}
					>
						<Trash className="size-4" />
						Delete view
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{dialog === "rename" && (
				<ViewNameDialog
					title="Rename view"
					description="The filters, the layout and the display options stay as they are."
					submitLabel="Rename"
					initialName={view.name}
					askPersonal={false}
					onSubmit={(name) =>
						send(client, { name: "view.update", args: { id: view.id, patch: { name } } })
					}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "delete" && (
				<ConfirmDialog
					title={`Delete "${view.name}"?`}
					confirmLabel="Delete view"
					onConfirm={() => {
						// Away first, so the page does not show the view as missing on the way out.
						void navigate({ to: "/$workspace", params: { workspace: slug } });
						send(client, { name: "view.delete", args: { id: view.id } });
					}}
					onClose={() => setDialog(null)}
				>
					{personal
						? "The view goes; the issues it shows stay as they are."
						: "The view goes for everyone in the workspace; the issues it shows stay as they are."}
				</ConfirmDialog>
			)}
		</>
	);
}
