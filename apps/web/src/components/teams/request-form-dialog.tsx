import type { Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { useWorkspace } from "#/components/workspace/context";
import { getIntakeFormsEnabled, intakeFormUrl } from "#/lib/intake";
import { send } from "#/lib/mutations";
import { useTeams } from "#/lib/queries";

/**
 * Turns a team's public request form on or off, and shares its link. Anyone with the link can
 * file a request into the team's intake. Admins only; the server checks again.
 */
export function RequestFormDialog({ team: initial, onClose }: { team: Team; onClose: () => void }) {
	const client = useSyncClient();
	const { id: workspaceId } = useWorkspace();
	// The live team, so the link shows up once the server has made it.
	const team = useTeams().find((each) => each.id === initial.id) ?? initial;
	const [enabled, setEnabled] = useState<boolean | null>(null);
	useEffect(() => {
		let current = true;
		getIntakeFormsEnabled()
			.then((value) => current && setEnabled(value))
			// Offline, the server cannot say; the form's switch works all the same.
			.catch(() => current && setEnabled(null));
		return () => {
			current = false;
		};
	}, []);

	const turn = (intakeForm: boolean) =>
		send(client, { name: "team.update", args: { id: team.id, patch: { intakeForm } } });
	const url = team.intakeFormKey ? intakeFormUrl(workspaceId, team.intakeFormKey) : null;

	async function copy() {
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Form link copied");
		} catch {
			toast.error("Could not copy the link", { description: url });
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Request form for {team.name}</DialogTitle>
					<DialogDescription>
						Anyone with the link can file a request into the team's intake, without an account.
						Someone on the team accepts or declines each one.
					</DialogDescription>
				</DialogHeader>
				{enabled === false && (
					<p role="alert" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
						This server takes no requests through forms until its admin sets Turnstile's keys
						(TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY). See the self-hosting guide.
					</p>
				)}
				{url ? (
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<input
								readOnly
								value={url}
								aria-label="Form link"
								onFocus={(event) => event.currentTarget.select()}
								className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 font-mono text-xs"
							/>
							<Button variant="outline" size="sm" onClick={copy}>
								<Copy />
								Copy
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							A new link retires this one, as turning the form off does.
						</p>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						{team.intakeFormKey === null ? "The form is off." : "Making the link…"}
					</p>
				)}
				<DialogFooter className="gap-2">
					{url ? (
						<>
							<Button variant="outline" onClick={() => turn(false)}>
								Turn off
							</Button>
							<Button variant="outline" onClick={() => turn(true)}>
								New link
							</Button>
						</>
					) : (
						<Button onClick={() => turn(true)}>Turn on</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
