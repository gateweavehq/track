import { WEBHOOK_EVENTS, type WebhookEventType } from "@gateweave/track-protocol";
import { useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, Plus, Send } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
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
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useActiveMembers, useTeams, useTeamsById } from "#/lib/queries";
import { cn } from "#/lib/utils";
import {
	createWebhook,
	deleteWebhook,
	rotateWebhookSecret,
	testWebhook,
	updateWebhook,
	type Webhook,
	type WebhookDelivery,
	type WorkspaceWebhooks,
} from "#/lib/webhooks";

const EVENT_LABELS: Record<WebhookEventType, string> = {
	"issue.created": "Issue created",
	"issue.updated": "Issue changed",
	"issue.deleted": "Issue deleted",
	"comment.created": "Comment added",
	"comment.updated": "Comment edited",
	"comment.deleted": "Comment deleted",
	"proposal.created": "Proposal made",
	"proposal.updated": "Proposal changed",
	"proposal.accepted": "Proposal accepted",
	"proposal.dismissed": "Proposal dismissed",
	"relation.created": "Relation added",
	"relation.deleted": "Relation removed",
};

/** A secret just made, shown once. */
interface NewSecret {
	url: string;
	secret: string;
}

const selectClass =
	"h-9 w-full rounded-md border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function WebhooksSettings({ data }: { data: WorkspaceWebhooks }) {
	const [creating, setCreating] = useState(false);
	const [newSecret, setNewSecret] = useState<NewSecret | null>(null);
	const { admin, enabled, webhooks, deliveries } = data;

	return (
		<section aria-labelledby="webhooks-heading" className="space-y-4">
			<div className="flex items-start gap-4">
				<div className="flex-1 space-y-1">
					<h2 id="webhooks-heading" className="text-base font-semibold">
						Webhooks
					</h2>
					<p className="text-sm text-muted-foreground">
						A webhook posts each change to a URL of yours as it happens, such as an agent's trigger.
						Every request is signed per{" "}
						<a
							href="https://www.standardwebhooks.com"
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2 hover:text-foreground"
						>
							Standard Webhooks
						</a>
						, so the receiver can check that it came from Track.
						{!admin && " Admins manage webhooks."}
					</p>
				</div>
				{admin && enabled && (
					<Button onClick={() => setCreating(true)}>
						<Plus />
						Add webhook
					</Button>
				)}
			</div>
			{!enabled && (
				<p className="rounded-lg border bg-muted/40 p-3 text-sm">
					This server sends no webhooks. The public demo has them turned off.
				</p>
			)}
			{newSecret && <SecretReveal newSecret={newSecret} onDone={() => setNewSecret(null)} />}
			{admin &&
				(webhooks.length === 0 ? (
					<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
						No webhooks yet.
					</p>
				) : (
					<ul className="divide-y rounded-lg border">
						{webhooks.map((webhook) => (
							<WebhookRow
								key={webhook.id}
								webhook={webhook}
								deliveries={deliveries.filter((delivery) => delivery.webhookId === webhook.id)}
								enabled={enabled}
								onSecret={setNewSecret}
							/>
						))}
					</ul>
				))}
			{creating && <WebhookDialog onClose={() => setCreating(false)} onCreated={setNewSecret} />}
		</section>
	);
}

function SecretReveal({ newSecret, onDone }: { newSecret: NewSecret; onDone: () => void }) {
	async function copy() {
		try {
			await navigator.clipboard.writeText(newSecret.secret);
			toast.success("Secret copied");
		} catch {
			toast.error("Could not copy the secret");
		}
	}
	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-3" aria-live="polite">
			<p className="text-sm">
				Copy the signing secret for <span className="break-all font-medium">{newSecret.url}</span>{" "}
				now and give it to the receiver. It is not shown again.
			</p>
			<div className="flex gap-2">
				<Input
					readOnly
					value={newSecret.secret}
					aria-label="Signing secret"
					onFocus={(event) => event.currentTarget.select()}
					className="font-mono text-xs"
				/>
				<Button variant="outline" onClick={copy}>
					<Copy />
					Copy
				</Button>
			</div>
			<Button variant="outline" size="sm" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

function WebhookRow({
	webhook,
	deliveries,
	enabled,
	onSecret,
}: {
	webhook: Webhook;
	deliveries: WebhookDelivery[];
	enabled: boolean;
	onSecret: (secret: NewSecret) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const teams = useTeamsById();
	const members = useActiveMembers();
	const [action, setAction] = useState<"edit" | "rotate" | "delete" | null>(null);
	const team = webhook.teamId ? teams.get(webhook.teamId) : undefined;
	const agent = webhook.agentId
		? members.find((member) => member.id === webhook.agentId)
		: undefined;

	async function sendTest() {
		const result = await testWebhook({ data: { workspace: slug, id: webhook.id } });
		if (!result.ok) {
			toast.error("Could not send a test", { description: result.message });
			return;
		}
		toast.success("Test event queued");
		// The delivery usually lands within a second; show its outcome.
		setTimeout(() => void router.invalidate(), 1500);
		await router.invalidate();
	}

	async function setActive(active: boolean) {
		const result = await updateWebhook({
			data: { workspace: slug, id: webhook.id, patch: { active } },
		});
		if (!result.ok) {
			toast.error(active ? "Could not resume the webhook" : "Could not pause the webhook", {
				description: result.message,
			});
			return;
		}
		await router.invalidate();
	}

	async function rotate() {
		const result = await rotateWebhookSecret({ data: { workspace: slug, id: webhook.id } });
		if (!result.ok) {
			toast.error("Could not make a new secret", { description: result.message });
			return;
		}
		onSecret({ url: webhook.url, secret: result.value });
		await router.invalidate();
	}

	async function remove() {
		const result = await deleteWebhook({ data: { workspace: slug, id: webhook.id } });
		if (!result.ok) {
			toast.error("Could not delete the webhook", { description: result.message });
			return;
		}
		toast.success("Webhook deleted");
		await router.invalidate();
	}

	const scope = [
		webhook.events.map((event) => EVENT_LABELS[event]).join(", "),
		team ? `${team.name} only` : "All teams",
		agent && `Skips ${agent.name}'s own changes`,
	].filter(Boolean);

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1 space-y-1">
					<p className="flex items-center gap-2 text-sm font-medium">
						<span className="truncate font-mono text-xs">{webhook.url}</span>
						{!webhook.active && (
							<span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
								Paused
							</span>
						)}
					</p>
					<p className="text-xs text-muted-foreground">{scope.join(" · ")}</p>
					<p className="text-xs text-muted-foreground">
						Secret <span className="font-mono">{webhook.secretStart}…</span>
					</p>
				</div>
				{enabled && webhook.active && (
					<Button variant="outline" size="sm" onClick={sendTest}>
						<Send />
						Send test
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={`More for ${webhook.url}`}
						>
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{enabled && (
							<>
								<DropdownMenuItem onSelect={() => setAction("edit")}>Edit</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => setActive(!webhook.active)}>
									{webhook.active ? "Pause" : "Resume"}
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => setAction("rotate")}>New secret</DropdownMenuItem>
								<DropdownMenuSeparator />
							</>
						)}
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setAction("delete")}
						>
							Delete webhook
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<Deliveries deliveries={deliveries} />
			{action === "edit" && <WebhookDialog webhook={webhook} onClose={() => setAction(null)} />}
			{action === "rotate" && (
				<ConfirmDialog
					title="Make a new secret?"
					confirmLabel="Make a new secret"
					onConfirm={rotate}
					onClose={() => setAction(null)}
				>
					Deliveries are signed with the new secret from now on. Until the receiver has it, they
					fail and are retried.
				</ConfirmDialog>
			)}
			{action === "delete" && (
				<ConfirmDialog
					title="Delete this webhook?"
					confirmLabel="Delete"
					onConfirm={remove}
					onClose={() => setAction(null)}
				>
					Track stops sending to <span className="break-all">{webhook.url}</span>, including what it
					had not delivered yet.
				</ConfirmDialog>
			)}
		</li>
	);
}

function Deliveries({ deliveries }: { deliveries: WebhookDelivery[] }) {
	if (deliveries.length === 0) {
		return <p className="text-xs text-muted-foreground">Nothing sent yet.</p>;
	}
	return (
		<details className="group text-xs">
			<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
				Recent deliveries
			</summary>
			<ul className="mt-2 space-y-1" aria-label="Recent deliveries">
				{deliveries.map((delivery) => (
					<li key={delivery.id} className="flex flex-wrap items-center gap-x-3">
						<DeliveryStatus delivery={delivery} />
						<span className="font-mono">{delivery.event}</span>
						<span className="text-muted-foreground" title={formatDateTime(delivery.createdAt)}>
							{formatRelative(delivery.createdAt)}
						</span>
						<span className="min-w-0 flex-1 truncate text-muted-foreground">
							{describeDelivery(delivery)}
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

function DeliveryStatus({ delivery }: { delivery: WebhookDelivery }) {
	const label = { delivered: "Delivered", pending: "Retrying", failed: "Failed" }[delivery.status];
	const shown = delivery.status === "pending" && delivery.attempts === 0 ? "Queued" : label;
	return (
		<span className="flex items-center gap-1.5">
			<span
				aria-hidden
				className={cn(
					"size-2 rounded-full",
					delivery.status === "delivered" && "bg-emerald-500",
					delivery.status === "pending" && "bg-amber-500",
					delivery.status === "failed" && "bg-destructive",
				)}
			/>
			{shown}
		</span>
	);
}

function describeDelivery(delivery: WebhookDelivery): string {
	const attempts = delivery.attempts === 1 ? "1 attempt" : `${delivery.attempts} attempts`;
	if (delivery.status === "delivered") return `${delivery.responseStatus} · ${attempts}`;
	if (delivery.attempts === 0) return delivery.error ?? "";
	const next =
		delivery.status === "pending" && delivery.nextAttemptAt
			? ` · next ${formatRelative(delivery.nextAttemptAt)}`
			: "";
	return `${delivery.error ?? "Failed"} · ${attempts}${next}`;
}

/** Adds a webhook, or edits one when given it. */
function WebhookDialog({
	webhook,
	onClose,
	onCreated,
}: {
	webhook?: Webhook;
	onClose: () => void;
	onCreated?: (secret: NewSecret) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const teams = useTeams();
	const agents = useActiveMembers().filter((member) => member.role === "agent");
	const formId = useId();
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [events, setEvents] = useState<WebhookEventType[]>(
		webhook?.events ?? ["issue.created", "issue.updated", "comment.created"],
	);
	const [teamId, setTeamId] = useState(webhook?.teamId ?? "");
	const [agentId, setAgentId] = useState(webhook?.agentId ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(event: WebhookEventType, on: boolean) {
		setEvents((current) =>
			on ? [...current, event] : current.filter((candidate) => candidate !== event),
		);
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const input = {
			url: url.trim(),
			events,
			teamId: teamId || null,
			agentId: agentId || null,
		};
		try {
			if (webhook) {
				const result = await updateWebhook({
					data: { workspace: slug, id: webhook.id, patch: input },
				});
				if (!result.ok) {
					setError(result.message);
					return;
				}
			} else {
				const result = await createWebhook({ data: { workspace: slug, input } });
				if (!result.ok) {
					setError(result.message);
					return;
				}
				onCreated?.({ url: result.value.webhook.url, secret: result.value.secret });
			}
			onClose();
			await router.invalidate();
		} catch {
			// The server function's validator refused the input before the workspace saw it, or
			// the request failed.
			setError("Could not save the webhook. Check the URL and the events.");
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{webhook ? "Edit webhook" : "Add webhook"}</DialogTitle>
					<DialogDescription>
						Track posts each event as JSON, signed with the webhook's secret, and retries for about
						a day while the receiver fails.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${formId}-url`}>URL</Label>
						<Input
							id={`${formId}-url`}
							type="url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://example.com/hooks/track"
							maxLength={2048}
							required
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Events</legend>
						<div className="grid grid-cols-1 gap-2 sm:grid-flow-col sm:grid-cols-2 sm:grid-rows-3">
							{WEBHOOK_EVENTS.map((name) => (
								<div key={name} className="flex items-center gap-2">
									<Checkbox
										id={`${formId}-${name}`}
										checked={events.includes(name)}
										onCheckedChange={(checked) => toggle(name, checked === true)}
									/>
									<Label htmlFor={`${formId}-${name}`} className="font-normal">
										{EVENT_LABELS[name]}
									</Label>
								</div>
							))}
						</div>
					</fieldset>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor={`${formId}-team`}>Team</Label>
							<select
								id={`${formId}-team`}
								value={teamId}
								onChange={(event) => setTeamId(event.target.value)}
								className={selectClass}
							>
								<option value="">All teams</option>
								{teams.map((team) => (
									<option key={team.id} value={team.id}>
										{team.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${formId}-agent`}>For agent</Label>
							<select
								id={`${formId}-agent`}
								value={agentId}
								onChange={(event) => setAgentId(event.target.value)}
								className={selectClass}
								aria-describedby={`${formId}-agent-help`}
							>
								<option value="">None</option>
								{agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
							</select>
						</div>
					</div>
					<p id={`${formId}-agent-help`} className="text-xs text-muted-foreground">
						When the webhook sets off an agent, choose it here. Its own changes are then not sent
						back to it, so it cannot set itself off.
					</p>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !url.trim() || events.length === 0}>
							{webhook ? "Save" : "Add webhook"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
