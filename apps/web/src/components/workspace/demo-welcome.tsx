import { ExternalLink, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { CLOUD_URL, REPOSITORY_URL } from "#/lib/demo-links";
import { useOpening } from "#/lib/demo-opening";
import { useWorkspace } from "./context";

const link = "font-medium text-foreground underline underline-offset-4";

/**
 * Shown once per sandbox, the first time it is on screen: what Track does that is worth trying.
 * It waits for the opening screen to go, and is marked seen when it appears, so a reload or a
 * second tab does not bring it back.
 */
export function DemoWelcome() {
	const { id } = useWorkspace();
	const opening = useOpening();
	const [open, setOpen] = useState(false);
	const waiting = opening.status !== "idle";

	useEffect(() => {
		if (waiting) return;
		const key = `track:demo-welcome:${id}`;
		try {
			if (localStorage.getItem(key)) return;
			localStorage.setItem(key, "1");
		} catch {
			// Without storage it would show on every load; better not to show it at all.
			return;
		}
		setOpen(true);
	}, [waiting, id]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>This workspace is yours for a day</DialogTitle>
					<DialogDescription>
						Nobody else can see it, and it is deleted a day after you opened it. Two things worth
						trying:
					</DialogDescription>
				</DialogHeader>
				<ul className="space-y-4 text-sm">
					<li className="flex gap-3">
						<ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<div className="space-y-2">
							<p>Open it in a second tab and watch changes arrive live.</p>
							<Button
								size="sm"
								variant="outline"
								onClick={() => window.open(window.location.href, "_blank", "noopener")}
							>
								Open in a new tab
							</Button>
						</div>
					</li>
					<li className="flex gap-3">
						<WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<p>
							Go offline, keep editing, then come back. Your changes wait on this device and sync
							when you reconnect.
						</p>
					</li>
				</ul>
				<p className="text-sm text-muted-foreground">
					Like it?{" "}
					<a href={CLOUD_URL} className={link} target="_blank" rel="noreferrer">
						Use it on Gateweave Cloud
					</a>
					, or{" "}
					<a href={REPOSITORY_URL} className={link} target="_blank" rel="noreferrer">
						deploy your own
					</a>
					.
				</p>
				<Button onClick={() => setOpen(false)}>Start exploring</Button>
			</DialogContent>
		</Dialog>
	);
}
