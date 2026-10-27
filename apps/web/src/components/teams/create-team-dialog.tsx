import { mutationSchema } from "@tangent/protocol";
import { uuidv7 } from "@tangent/sync-client";
import { useSyncClient } from "@tangent/sync-client/react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { useWorkspace } from "#/components/workspace/context";
import { useTeams } from "#/lib/queries";

/** A team key suggestion from its name: "Platform Engineering" becomes "PE", "Design" "DES". */
function suggestKey(name: string): string {
	const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
	const key =
		words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "").slice(0, 3);
	return key.replace(/^[0-9]+/, "").slice(0, 7);
}

export function CreateTeamForm({ onCreated }: { onCreated?: () => void }) {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const teams = useTeams();
	const [name, setName] = useState("");
	const [key, setKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const effectiveKey = key ?? suggestKey(name);

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const mutation = {
			name: "team.create" as const,
			args: { id: uuidv7(), key: effectiveKey, name },
		};
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the name and key");
			return;
		}
		if (teams.some((team) => team.key === effectiveKey)) {
			setError(`Another team already uses ${effectiveKey}`);
			return;
		}
		// Another client may take the key first; the server then rejects this and onReject reports it.
		void client.mutate(mutation);
		onCreated?.();
		void navigate({
			to: "/$workspace/team/$teamKey",
			params: { workspace: slug, teamKey: effectiveKey },
		});
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="team-name">Name</Label>
				<Input
					id="team-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Engineering"
					maxLength={64}
					autoFocus
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="team-key">Key</Label>
				<Input
					id="team-key"
					value={effectiveKey}
					onChange={(event) => setKey(event.target.value.toUpperCase())}
					placeholder="ENG"
					maxLength={7}
					className="font-mono"
					aria-describedby="team-key-hint"
					required
				/>
				<p id="team-key-hint" className="text-xs text-muted-foreground">
					Issue identifiers start with it, like {effectiveKey || "ENG"}-1.
				</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<Button type="submit" disabled={!name.trim() || !effectiveKey}>
				Create team
			</Button>
		</form>
	);
}

export function CreateTeamDialog({ onClose }: { onClose: () => void }) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>New team</DialogTitle>
					<DialogDescription>Teams group issues and give them their prefix.</DialogDescription>
				</DialogHeader>
				<CreateTeamForm onCreated={onClose} />
			</DialogContent>
		</Dialog>
	);
}
