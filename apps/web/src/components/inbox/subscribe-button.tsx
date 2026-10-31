import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { send } from "#/lib/mutations";
import { useMembersById, useSubscription } from "#/lib/queries";

/**
 * Subscribes the person to the issue, or unsubscribes them. Subscribers hear of comments, status
 * changes and agents' proposals in their inbox. Agents have no inbox, so they get no button.
 */
export function SubscribeButton({ issueId }: { issueId: string }) {
	const client = useSyncClient();
	const { userId } = useWorkspace();
	const subscribed = useSubscription(issueId, userId)?.subscribed === true;
	const agent = useMembersById().get(userId)?.role === "agent";
	if (agent) return null;

	const label = subscribed ? "Unsubscribe" : "Subscribe";
	return (
		<Button
			variant="ghost"
			size="sm"
			aria-pressed={subscribed}
			title={
				subscribed
					? "You hear of comments and status changes in your inbox"
					: "Hear of comments and status changes in your inbox"
			}
			onClick={() =>
				send(client, { name: "issue.subscribe", args: { issueId, subscribed: !subscribed } })
			}
		>
			{subscribed ? <BellOff /> : <Bell />}
			{label}
		</Button>
	);
}
