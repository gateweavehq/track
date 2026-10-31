import type {
	NotificationKind,
	NotificationLevel,
	NotificationSettings as Settings,
} from "@gateweave/track-protocol";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "#/components/workspace/context";
import { updateNotificationSettings, type WorkspaceNotifications } from "#/lib/notifications";

const KINDS: { kind: NotificationKind; label: string; description: string }[] = [
	{ kind: "assigned", label: "Assigned to you", description: "Someone makes you the assignee." },
	{ kind: "comment", label: "Comments", description: "Someone comments on an issue you follow." },
	{
		kind: "status",
		label: "Status changes",
		description: "An issue you follow moves to another status.",
	},
	{
		kind: "proposal",
		label: "Agents' proposals",
		description: "An agent proposes a change to an issue you follow, for a person to decide.",
	},
	{ kind: "unassigned", label: "Unassigned", description: "Someone takes you off an issue." },
];

const LEVELS: { level: NotificationLevel; label: string }[] = [
	{ level: "email", label: "Inbox and email" },
	{ level: "inbox", label: "Inbox" },
	{ level: "off", label: "Off" },
];

export function NotificationSettings({ data }: { data: WorkspaceNotifications }) {
	const { slug } = useWorkspace();
	const [settings, setSettings] = useState<Settings>(data.settings);

	async function change(kind: NotificationKind, level: NotificationLevel) {
		const before = settings;
		setSettings({ ...settings, [kind]: level });
		try {
			const result = await updateNotificationSettings({
				data: { workspace: slug, patch: { [kind]: level } },
			});
			if (result.ok) setSettings(result.value);
			else throw new Error(result.message);
		} catch (error) {
			setSettings(before);
			toast.error("Could not change the setting", {
				description: error instanceof Error ? error.message : undefined,
			});
		}
	}

	return (
		<section aria-labelledby="notifications-heading" className="space-y-4">
			<div className="space-y-2">
				<h2 id="notifications-heading" className="text-base font-semibold">
					Notifications
				</h2>
				<p className="text-sm text-muted-foreground">
					Choose what reaches your inbox in this workspace, and what is also emailed to you. You
					follow the issues you create, are assigned or comment on, and any you subscribe to.
				</p>
				<EmailNote data={data} />
			</div>
			<ul className="divide-y rounded-lg border" aria-label="Notification settings">
				{KINDS.map(({ kind, label, description }) => (
					<li key={kind} className="flex items-center gap-4 px-4 py-3">
						<div className="min-w-0 flex-1">
							<p id={`notification-${kind}`} className="text-sm font-medium">
								{label}
							</p>
							<p className="text-sm text-muted-foreground">{description}</p>
						</div>
						<select
							aria-labelledby={`notification-${kind}`}
							value={settings[kind]}
							onChange={(event) => {
								const level = LEVELS.find((each) => each.level === event.target.value)?.level;
								if (level) void change(kind, level);
							}}
							className="flex h-9 w-40 shrink-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
						>
							{LEVELS.map(({ level, label }) => (
								<option key={level} value={level}>
									{label}
								</option>
							))}
						</select>
					</li>
				))}
			</ul>
		</section>
	);
}

function EmailNote({ data }: { data: WorkspaceNotifications }) {
	if (data.email === "off") {
		return (
			<p className="rounded-lg border bg-muted/40 p-3 text-sm">
				This server sends no email, so news reaches your inbox alone.
			</p>
		);
	}
	if (data.email === "unverified") {
		return (
			<p className="rounded-lg border bg-muted/40 p-3 text-sm">
				No email is sent until you verify {data.address}. The email you got when you signed up has
				the link.
			</p>
		);
	}
	return (
		<p className="text-sm text-muted-foreground">
			Email goes to {data.address} when news stays unread for 10 minutes, gathered into one email at
			most once an hour. Reading it in Track first keeps it out of your email.
		</p>
	);
}
