import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { pushIsOn, pushSupport, turnPushOff, turnPushOn } from "#/lib/push-device";

type State = "checking" | "on" | "off" | "denied" | "home-screen" | "none";

const ABOUT =
	"What you get by email (Inbox and email above) also shows on this device as it happens, from every workspace you are in. It stops when you sign out here.";

const NOTES: Record<State, string> = {
	checking: ABOUT,
	on: ABOUT,
	off: ABOUT,
	denied:
		"Notifications are blocked for Track in this browser. Allow them in the browser's settings for this site, then come back.",
	"home-screen":
		"On iPhone and iPad, add Track to your Home Screen first (Share, then Add to Home Screen), and turn push on in the app you added.",
	none: "This browser can't show push notifications.",
};

/** Push in this browser, for the signed-in person. `publicKey` is the server's. */
export function PushSettings({ publicKey }: { publicKey: string }) {
	const { userId } = useWorkspace();
	const [state, setState] = useState<State>("checking");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const support = pushSupport();
		if (support !== "ready") {
			setState(support);
			return;
		}
		if (Notification.permission === "denied") {
			setState("denied");
			return;
		}
		pushIsOn(userId).then(
			(on) => setState(on ? "on" : "off"),
			() => setState("off"),
		);
	}, [userId]);

	async function toggle() {
		setBusy(true);
		try {
			if (state === "on") {
				await turnPushOff();
				setState("off");
				return;
			}
			const outcome = await turnPushOn(userId, publicKey);
			if (outcome === "denied") setState(Notification.permission === "denied" ? "denied" : "off");
			else if (outcome === "refused")
				throw new Error("You may have been signed out. Reload the page.");
			else setState("on");
		} catch (error) {
			toast.error(state === "on" ? "Could not turn push off" : "Could not turn push on", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setBusy(false);
		}
	}

	const canToggle = state === "on" || state === "off";
	return (
		<div className="flex items-center gap-4 rounded-lg border px-4 py-3">
			<div className="min-w-0 flex-1">
				<p id="push-heading" className="text-sm font-medium">
					Push notifications on this device
				</p>
				<p className="text-sm text-muted-foreground">{NOTES[state]}</p>
			</div>
			{canToggle && (
				<Button
					variant={state === "on" ? "outline" : "default"}
					aria-describedby="push-heading"
					disabled={busy}
					onClick={() => void toggle()}
				>
					{state === "on" ? "Turn off" : "Turn on"}
				</Button>
			)}
		</div>
	);
}
