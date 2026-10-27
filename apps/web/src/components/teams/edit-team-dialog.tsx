import { mutationSchema, type Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { type FormEvent, useState } from "react";
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
import { send } from "#/lib/mutations";
import { useTeams } from "#/lib/queries";

/** Renames a team or changes its key. Admins only; the server checks again. */
export function EditTeamDialog({ team, onClose }: { team: Team; onClose: () => void }) {
	const client = useSyncClient();
	const teams = useTeams();
	const [name, setName] = useState(team.name);
	const [key, setKey] = useState(team.key);
	const [error, setError] = useState<string | null>(null);
	const keyChanged = key !== team.key;

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const patch = {
			...(name !== team.name && { name }),
			...(keyChanged && { key }),
		};
		if (Object.keys(patch).length === 0) {
			onClose();
			return;
		}
		const mutation = { name: "team.update" as const, args: { id: team.id, patch } };
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the name and key");
			return;
		}
		if (keyChanged && teams.some((other) => other.id !== team.id && other.key === key)) {
			setError(`Another team already uses ${key}`);
			return;
		}
		if (send(client, mutation)) onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Edit {team.name}</DialogTitle>
					<DialogDescription>
						Change the team's name or the key its issues start with.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="edit-team-name">Name</Label>
						<Input
							id="edit-team-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={64}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="edit-team-key">Key</Label>
						<Input
							id="edit-team-key"
							value={key}
							onChange={(event) => setKey(event.target.value.toUpperCase())}
							maxLength={7}
							className="font-mono"
							aria-describedby="edit-team-key-hint"
							required
						/>
						<p id="edit-team-key-hint" className="text-xs text-muted-foreground">
							{keyChanged
								? `Issues become ${key || "…"}-1, ${key || "…"}-2 and so on. Links that use ${team.key}- stop working.`
								: `Issue identifiers start with it, like ${team.key}-1.`}
						</p>
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
						<Button type="submit" disabled={!name.trim() || !key}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
