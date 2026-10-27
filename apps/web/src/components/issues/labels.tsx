import type { Issue, Label } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Check, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { compareLabels, defaultLabelColor, findLabelByName } from "#/lib/labels";
import { send } from "#/lib/mutations";
import { useLabels, useLabelsById } from "#/lib/queries";
import { cn } from "#/lib/utils";

export function LabelDot({ color, className }: { color: string; className?: string }) {
	return (
		<span
			aria-hidden
			className={cn("size-2 shrink-0 rounded-full", className)}
			style={{ backgroundColor: color }}
		/>
	);
}

export function LabelChip({ label }: { label: Label }) {
	return (
		<span className="inline-flex h-5 max-w-32 shrink-0 items-center gap-1 rounded-full border px-1.5 text-xs text-muted-foreground">
			<LabelDot color={label.color} />
			<span className="truncate">{label.name}</span>
		</span>
	);
}

/**
 * An issue's labels, by name. Ids that no longer resolve are skipped: a label deleted elsewhere
 * can be gone from the replica a moment before its issues are updated.
 */
export function LabelChips({
	labelIds,
	max,
	className,
}: {
	labelIds: readonly string[];
	/** Show at most this many, then "+N". */
	max?: number;
	className?: string;
}) {
	const labelsById = useLabelsById();
	const labels = labelIds
		.map((id) => labelsById.get(id))
		.filter((label) => label !== undefined)
		.sort(compareLabels);
	if (labels.length === 0) return null;
	const shown = max === undefined ? labels : labels.slice(0, max);
	const rest = labels.slice(shown.length);

	return (
		<span className={cn("flex min-w-0 items-center gap-1", className)}>
			{shown.map((label) => (
				<LabelChip key={label.id} label={label} />
			))}
			{rest.length > 0 && (
				<span
					className="shrink-0 text-xs text-muted-foreground"
					title={rest.map((label) => label.name).join(", ")}
				>
					+{rest.length}
				</span>
			)}
		</span>
	);
}

/**
 * Adds and removes an issue's labels, and creates a label from what was typed when none has that
 * name. It stays open between picks, since issues often get more than one.
 */
export function LabelPicker({
	issue,
	children,
	open: controlledOpen,
	onOpenChange,
}: {
	issue: Issue;
	/** The trigger. Must be a single element that accepts a ref, such as a button. */
	children: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const client = useSyncClient();
	const labels = useLabels();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const [search, setSearch] = useState("");
	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;
	const name = search.trim();
	const canCreate = name.length > 0 && name.length <= 64 && !findLabelByName(labels, name);
	const selected = new Set(issue.labelIds);

	function toggle(label: Label) {
		send(client, {
			name: selected.has(label.id) ? "issue.removeLabel" : "issue.addLabel",
			args: { id: issue.id, labelId: label.id },
		});
	}

	function create() {
		const id = uuidv7();
		const created = send(client, {
			name: "label.create",
			args: { id, name, color: defaultLabelColor(name) },
		});
		if (created) send(client, { name: "issue.addLabel", args: { id: issue.id, labelId: id } });
		setSearch("");
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setSearch("");
			}}
		>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent className="w-60 p-0">
				<Command loop vimBindings={false}>
					<CommandInput placeholder="Add labels…" value={search} onValueChange={setSearch} />
					<CommandList>
						{/* The create item is always mounted, so cmdk would show this next to it. */}
						{!canCreate && (
							<CommandEmpty>
								{labels.length === 0 ? "Type to create a label" : "No matches"}
							</CommandEmpty>
						)}
						<CommandGroup>
							{labels.map((label) => (
								<CommandItem
									key={label.id}
									value={label.id}
									keywords={[label.name]}
									onSelect={() => toggle(label)}
								>
									<LabelDot color={label.color} />
									<span className="truncate">{label.name}</span>
									{selected.has(label.id) && <Check className="ml-auto size-4" />}
								</CommandItem>
							))}
							{canCreate && (
								<CommandItem forceMount value={`create:${name}`} onSelect={create}>
									<Plus />
									<span className="truncate">Create label “{name}”</span>
								</CommandItem>
							)}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
