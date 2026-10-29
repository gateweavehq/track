import { AGENT_CHANGE_KINDS, type AgentChangeKind } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, KeyRound, Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/members/member-avatar";
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
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import type { AgentInfo, AgentKeyInfo } from "#/lib/agents";
import { authClient } from "#/lib/auth-client";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";
import { send } from "#/lib/mutations";
import { useMembersById } from "#/lib/queries";

/** A key just made, shown once. */
interface NewKey {
	agentName: string;
	secret: string;
}

export function AgentsSettings({
	admin,
	agents,
	mcpUrl,
}: {
	admin: boolean;
	agents: AgentInfo[];
	/** Where agents connect, or null when this server has MCP turned off. */
	mcpUrl: string | null;
}) {
	const [newKey, setNewKey] = useState<NewKey | null>(null);
	return (
		<section aria-labelledby="agents-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="agents-heading" className="text-base font-semibold">
					Agents
				</h2>
				<p className="text-sm text-muted-foreground">
					An agent is a member for an AI agent, such as one that triages new issues. It connects
					over MCP with a key, can do what members do, and everyone sees its changes as they happen.
					It never signs in, and it cannot manage the workspace. Choose which kinds of change it
					only proposes, for a person to accept.
					{!admin && " Admins create agents and their keys."}
				</p>
			</div>
			{admin && !mcpUrl && (
				<p className="rounded-lg border bg-muted/40 p-3 text-sm">
					MCP is off on this server, so agents cannot connect yet. Set{" "}
					<code className="font-mono text-xs">BETTER_AUTH_URL</code> to turn it on.
				</p>
			)}
			{admin && <CreateAgentForm onCreated={setNewKey} />}
			{newKey && <KeyReveal newKey={newKey} mcpUrl={mcpUrl} onDone={() => setNewKey(null)} />}
			{admin &&
				(agents.length === 0 ? (
					<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
						No agents yet.
					</p>
				) : (
					<ul className="divide-y rounded-lg border">
						{agents.map((agent) => (
							<AgentRow key={agent.id} agent={agent} onNewKey={setNewKey} />
						))}
					</ul>
				))}
		</section>
	);
}

function CreateAgentForm({ onCreated }: { onCreated: (key: NewKey) => void }) {
	const { id: organizationId } = useWorkspace();
	const router = useRouter();
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await authClient.agents.create({ organizationId, name: name.trim() });
		setPending(false);
		if (result.error || !result.data) {
			setError(result.error?.message ?? "Could not create the agent");
			return;
		}
		onCreated({ agentName: result.data.agent.name, secret: result.data.key });
		setName("");
		await router.invalidate();
	}

	return (
		<div className="space-y-2">
			<form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Triage"
					aria-label="Agent name"
					maxLength={80}
					required
					className="sm:flex-1"
				/>
				<Button type="submit" disabled={pending || !name.trim()}>
					<Plus />
					Create agent
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

function KeyReveal({
	newKey,
	mcpUrl,
	onDone,
}: {
	newKey: NewKey;
	mcpUrl: string | null;
	onDone: () => void;
}) {
	async function copy(text: string, what: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`${what} copied`);
		} catch {
			toast.error(`Could not copy the ${what.toLowerCase()}`);
		}
	}
	const command = mcpUrl
		? `claude mcp add --transport http track ${mcpUrl} --header "Authorization: Bearer ${newKey.secret}"`
		: null;

	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-3" aria-live="polite">
			<p className="text-sm">
				Copy the key for <span className="font-medium">{newKey.agentName}</span> now. Track keeps
				only a hash of it, so it is never shown again.
			</p>
			<div className="flex gap-2">
				<Input
					readOnly
					value={newKey.secret}
					aria-label="Agent key"
					onFocus={(event) => event.currentTarget.select()}
					className="font-mono text-xs"
				/>
				<Button variant="outline" onClick={() => copy(newKey.secret, "Key")}>
					<Copy />
					Copy
				</Button>
			</div>
			{mcpUrl && command && (
				<div className="space-y-2 text-sm text-muted-foreground">
					<p>
						The agent's MCP client connects to{" "}
						<code className="font-mono text-xs text-foreground">{mcpUrl}</code> and sends the key as{" "}
						<code className="font-mono text-xs text-foreground">Authorization: Bearer …</code>. With
						Claude Code, for example:
					</p>
					<div className="flex items-start gap-2">
						<pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs text-foreground">
							{command}
						</pre>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label="Copy the command"
							onClick={() => copy(command, "Command")}
						>
							<Copy />
						</Button>
					</div>
				</div>
			)}
			<Button variant="outline" size="sm" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

function AgentRow({ agent, onNewKey }: { agent: AgentInfo; onNewKey: (key: NewKey) => void }) {
	const router = useRouter();
	const [action, setAction] = useState<"rename" | "delete" | null>(null);
	const [revoking, setRevoking] = useState<AgentKeyInfo | null>(null);

	async function newKey() {
		const result = await authClient.agents.createKey({ agentId: agent.id });
		if (result.error || !result.data) {
			toast.error("Could not make a key", { description: result.error?.message });
			return;
		}
		onNewKey({ agentName: agent.name, secret: result.data.secret });
		await router.invalidate();
	}

	async function revoke(key: AgentKeyInfo) {
		const result = await authClient.agents.revokeKey({ keyId: key.id });
		if (result.error) {
			toast.error("Could not revoke the key", { description: result.error.message });
			return;
		}
		toast.success(`Key ${key.start}… revoked`);
		await router.invalidate();
	}

	async function remove() {
		const result = await authClient.agents.delete({ agentId: agent.id });
		if (result.error) {
			toast.error(`Could not delete ${agent.name}`, { description: result.error.message });
			return;
		}
		toast.success(`${agent.name} was deleted`);
		await router.invalidate();
	}

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="flex items-center gap-3">
				<MemberAvatar
					member={{
						id: agent.id,
						name: agent.name,
						email: "",
						image: agent.image,
						role: "agent",
						removedAt: null,
					}}
					className="size-8 text-xs"
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{agent.name}</p>
					<p className="text-xs text-muted-foreground">
						Created {formatShortDate(agent.createdAt)}
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={newKey}>
					<KeyRound />
					New key
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={`More for ${agent.name}`}
						>
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => setAction("rename")}>Rename</DropdownMenuItem>
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setAction("delete")}
						>
							Delete agent
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{agent.keys.length === 0 ? (
				<p className="pl-11 text-xs text-muted-foreground">
					No keys. It cannot connect until you make one.
				</p>
			) : (
				<ul className="space-y-1 pl-11" aria-label={`Keys of ${agent.name}`}>
					{agent.keys.map((key) => (
						<li key={key.id} className="flex flex-wrap items-center gap-x-3 text-xs">
							<span className="font-mono">{key.start}…</span>
							<span className="text-muted-foreground" title={formatDateTime(key.createdAt)}>
								Made {formatShortDate(key.createdAt)}
							</span>
							<span className="flex-1 text-muted-foreground">
								{key.lastUsedAt === null ? "Never used" : `Used ${formatRelative(key.lastUsedAt)}`}
							</span>
							<Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
			<ProposalSettings agent={agent} />
			{revoking && (
				<ConfirmDialog
					title={`Revoke key ${revoking.start}…?`}
					confirmLabel="Revoke"
					onConfirm={() => revoke(revoking)}
					onClose={() => setRevoking(null)}
				>
					Whatever uses it loses access right away. {agent.name}'s other keys keep working.
				</ConfirmDialog>
			)}
			{action === "delete" && (
				<ConfirmDialog
					title={`Delete ${agent.name}?`}
					confirmLabel="Delete"
					onConfirm={remove}
					onClose={() => setAction(null)}
				>
					Its keys stop working right away. Issues it created or was assigned keep its name.
				</ConfirmDialog>
			)}
			{action === "rename" && <RenameAgentDialog agent={agent} onClose={() => setAction(null)} />}
		</li>
	);
}

const CHANGE_KIND_LABELS: Record<AgentChangeKind, string> = {
	title: "Title",
	description: "Description",
	status: "Status",
	close: "Closing, as Done or Canceled",
	priority: "Priority",
	assignee: "Assignee",
	labels: "Labels",
	project: "Project",
};

/**
 * Which kinds of change the agent proposes rather than makes. The setting lives in the
 * workspace, where the Durable Object enforces it, so it is read from and written to the replica.
 */
function ProposalSettings({ agent }: { agent: AgentInfo }) {
	const client = useSyncClient();
	const id = useId();
	const proposes = useMembersById().get(agent.id)?.proposes ?? [];

	function toggle(kind: AgentChangeKind, on: boolean) {
		const next = on ? [...proposes, kind] : proposes.filter((other) => other !== kind);
		send(client, { name: "agent.update", args: { id: agent.id, patch: { proposes: next } } });
	}

	return (
		<fieldset className="space-y-2 pl-11">
			<legend className="text-xs font-medium">Proposes instead of making</legend>
			<p className="text-xs text-muted-foreground">
				These wait on the issue until someone accepts or dismisses them. {agent.name} makes every
				other change directly.
			</p>
			<div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
				{AGENT_CHANGE_KINDS.map((kind) => {
					// Proposing every status change includes closing.
					const implied = kind === "close" && proposes.includes("status");
					return (
						<div key={kind} className="flex items-center gap-2">
							<Checkbox
								id={`${id}-${kind}`}
								checked={implied || proposes.includes(kind)}
								disabled={implied}
								onCheckedChange={(checked) => toggle(kind, checked === true)}
							/>
							<Label htmlFor={`${id}-${kind}`} className="text-xs font-normal">
								{CHANGE_KIND_LABELS[kind]}
							</Label>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}

function RenameAgentDialog({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
	const router = useRouter();
	const [name, setName] = useState(agent.name);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (name.trim() === agent.name) {
			onClose();
			return;
		}
		setPending(true);
		const result = await authClient.agents.update({ agentId: agent.id, name: name.trim() });
		setPending(false);
		if (result.error) {
			setError(result.error.message ?? "Could not rename the agent");
			return;
		}
		onClose();
		await router.invalidate();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Rename {agent.name}</DialogTitle>
					<DialogDescription>Everyone sees the new name on what it did and does.</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="rename-agent">Name</Label>
						<Input
							id="rename-agent"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={80}
							required
						/>
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
						<Button type="submit" disabled={pending || !name.trim()}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
