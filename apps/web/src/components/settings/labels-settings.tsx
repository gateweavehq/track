import { type Label as LabelEntity, mutationSchema } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Check, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LabelDot } from "#/components/issues/labels";
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
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { defaultLabelColor, findLabelByName, LABEL_COLORS } from "#/lib/labels";
import { send } from "#/lib/mutations";
import { useIssueCountsByLabel, useLabels } from "#/lib/queries";

export function LabelsSettings() {
	const client = useSyncClient();
	const admin = isAdmin(useMyRole());
	const labels = useLabels();
	const counts = useIssueCountsByLabel();
	const [editing, setEditing] = useState<LabelEntity | "new" | null>(null);
	const [deleting, setDeleting] = useState<LabelEntity | null>(null);

	return (
		<section aria-labelledby="labels-heading" className="space-y-4">
			<div className="flex items-end justify-between gap-4">
				<div className="space-y-1">
					<h2 id="labels-heading" className="text-base font-semibold">
						Labels
					</h2>
					<p className="text-sm text-muted-foreground">
						Labels are shared by every team in the workspace. Anyone can create and edit them.
						{admin ? " Deleting one removes it from every issue." : " Admins delete them."}
					</p>
				</div>
				<Button size="sm" onClick={() => setEditing("new")}>
					<Plus />
					Create label
				</Button>
			</div>
			{labels.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					No labels yet. Create one here, or from an issue's Labels menu.
				</p>
			) : (
				<ul className="divide-y rounded-lg border">
					{labels.map((label) => {
						const count = counts.get(label.id) ?? 0;
						return (
							<li key={label.id} className="flex items-center gap-3 px-4 py-3">
								<LabelDot color={label.color} className="size-3" />
								<span className="min-w-0 flex-1 truncate text-sm font-medium">{label.name}</span>
								<span className="text-xs text-muted-foreground tabular-nums">
									{count === 1 ? "1 issue" : `${count} issues`}
								</span>
								<Button variant="ghost" size="sm" onClick={() => setEditing(label)}>
									Edit
								</Button>
								{admin && (
									<Button variant="ghost" size="sm" onClick={() => setDeleting(label)}>
										Delete
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{editing && (
				<LabelDialog
					label={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title={`Delete ${deleting.name}?`}
					confirmLabel="Delete label"
					onConfirm={() => {
						send(client, { name: "label.delete", args: { id: deleting.id } });
					}}
					onClose={() => setDeleting(null)}
				>
					{removalNote(counts.get(deleting.id) ?? 0)}
				</ConfirmDialog>
			)}
		</section>
	);
}

function removalNote(count: number): string {
	if (count === 0) return "No issue has this label.";
	if (count === 1) return "It is removed from the one issue that has it.";
	return `It is removed from all ${count} issues that have it.`;
}

/** Creates a label, or renames and recolors one. The server checks names again. */
function LabelDialog({ label, onClose }: { label: LabelEntity | undefined; onClose: () => void }) {
	const client = useSyncClient();
	const labels = useLabels();
	const [name, setName] = useState(label?.name ?? "");
	// A new label takes its name's default color until a color is picked.
	const [pickedColor, setPickedColor] = useState<string | null>(label?.color ?? null);
	const [error, setError] = useState<string | null>(null);
	const color = pickedColor ?? defaultLabelColor(name);

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const taken = findLabelByName(labels, name);
		if (taken && taken.id !== label?.id) {
			setError(`There is already a label named ${taken.name}`);
			return;
		}
		const mutation = label
			? {
					name: "label.update" as const,
					args: {
						id: label.id,
						patch: {
							...(name.trim() !== label.name && { name }),
							...(color !== label.color && { color }),
						},
					},
				}
			: { name: "label.create" as const, args: { id: uuidv7(), name, color } };
		if (mutation.name === "label.update" && Object.keys(mutation.args.patch).length === 0) {
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

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{label ? `Edit ${label.name}` : "Create label"}</DialogTitle>
					<DialogDescription>
						{label
							? "Changes show on every issue with this label."
							: "Add it to issues from their Labels menu."}
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="label-name">Name</Label>
						<Input
							id="label-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={64}
							placeholder="Bug"
							required
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Color</legend>
						<div className="flex flex-wrap gap-2">
							{LABEL_COLORS.map((option) => (
								<button
									key={option.value}
									type="button"
									aria-label={option.name}
									aria-pressed={color === option.value}
									onClick={() => setPickedColor(option.value)}
									className="flex size-7 items-center justify-center rounded-full ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
									style={{ backgroundColor: option.value }}
								>
									{color === option.value && <Check className="size-4 text-white" />}
								</button>
							))}
						</div>
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
						<Button type="submit" disabled={!name.trim()}>
							{label ? "Save" : "Create label"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
