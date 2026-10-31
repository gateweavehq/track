import { useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	createGitHubConnection,
	deleteGitHubConnection,
	type GitHubConnection,
	rotateGitHubSecret,
	type WorkspaceGitHub,
} from "#/lib/github";
import { useMembersById } from "#/lib/queries";

const EVENT_LABELS: Record<string, string> = {
	pull_request: "Pull request",
	push: "Push",
	ping: "Ping",
};

/** A secret just made, shown once, with where it goes. */
interface NewSecret {
	url: string;
	secret: string;
	/** A new connection needs the whole setup; a rotated secret only replaces the old one. */
	rotated: boolean;
}

export function GitHubSettings({ data }: { data: WorkspaceGitHub }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [newSecret, setNewSecret] = useState<NewSecret | null>(null);
	const [pending, setPending] = useState(false);
	const { admin, enabled, endpoint, connections } = data;

	async function add() {
		setPending(true);
		try {
			const result = await createGitHubConnection({ data: { workspace: slug } });
			if (!result.ok) {
				toast.error("Could not add a connection", { description: result.message });
				return;
			}
			setNewSecret({
				url: `${endpoint}/${result.value.connection.id}`,
				secret: result.value.secret,
				rotated: false,
			});
			await router.invalidate();
		} finally {
			setPending(false);
		}
	}

	return (
		<section aria-labelledby="github-heading" className="space-y-4">
			<div className="flex items-start gap-4">
				<div className="flex-1 space-y-2">
					<h2 id="github-heading" className="text-base font-semibold">
						GitHub
					</h2>
					<p className="text-sm text-muted-foreground">
						Connect a repository, or every repository of an organization, with a webhook on GitHub.
						Pull requests and commits that name an issue, such as ENG-12, are linked to it and move
						it along:
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						<li>
							A draft pull request moves the issue to In Progress, and an open one to In Review.
						</li>
						<li>
							A merged pull request moves the issues it fixes to Done: the one its branch is named
							for, and any its title or description names after “Fixes”, “Closes” or “Resolves”.
						</li>
						<li>A commit to the default branch that says “Fixes ENG-12” moves ENG-12 to Done.</li>
					</ul>
					<p className="text-sm text-muted-foreground">
						Track never moves an issue back, nor out of Done or Canceled.
						{!admin && " Admins manage connections."}
					</p>
				</div>
				{admin && enabled && (
					<Button onClick={add} disabled={pending}>
						<Plus />
						Add connection
					</Button>
				)}
			</div>
			{!enabled && (
				<p className="rounded-lg border bg-muted/40 p-3 text-sm">
					This server connects to no GitHub repositories. The public demo has it turned off.
				</p>
			)}
			{newSecret && <SetupSteps newSecret={newSecret} onDone={() => setNewSecret(null)} />}
			{admin &&
				(connections.length === 0 ? (
					<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
						No connections yet.
					</p>
				) : (
					<ul className="divide-y rounded-lg border" aria-label="Connections">
						{connections.map((connection) => (
							<ConnectionRow
								key={connection.id}
								connection={connection}
								url={`${endpoint}/${connection.id}`}
								enabled={enabled}
								onSecret={setNewSecret}
							/>
						))}
					</ul>
				))}
		</section>
	);
}

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} copied`);
	} catch {
		toast.error(`Could not copy the ${what.toLowerCase()}`);
	}
}

function CopyField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<Input
				readOnly
				value={value}
				aria-label={label}
				onFocus={(event) => event.currentTarget.select()}
				className="font-mono text-xs"
			/>
			<Button variant="outline" onClick={() => copy(value, label)}>
				<Copy />
				Copy
			</Button>
		</div>
	);
}

function SetupSteps({ newSecret, onDone }: { newSecret: NewSecret; onDone: () => void }) {
	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-3" aria-live="polite">
			{newSecret.rotated ? (
				<p className="text-sm">
					Paste the new secret into the webhook on GitHub now. Until then its deliveries are
					refused. It is not shown again.
				</p>
			) : (
				<p className="text-sm">
					On GitHub, open the repository's or the organization's Settings, then Webhooks, and add a
					webhook with these values. The secret is not shown again.
				</p>
			)}
			<dl className="space-y-3 text-sm">
				<div className="space-y-1">
					<dt className="font-medium">Payload URL</dt>
					<dd>
						<CopyField label="Payload URL" value={newSecret.url} />
					</dd>
				</div>
				{!newSecret.rotated && (
					<div className="space-y-1">
						<dt className="font-medium">Content type</dt>
						<dd className="font-mono text-xs">application/json</dd>
					</div>
				)}
				<div className="space-y-1">
					<dt className="font-medium">Secret</dt>
					<dd>
						<CopyField label="Secret" value={newSecret.secret} />
					</dd>
				</div>
				{!newSecret.rotated && (
					<div className="space-y-1">
						<dt className="font-medium">Events</dt>
						<dd>“Let me select individual events”, then Pull requests and Pushes.</dd>
					</div>
				)}
			</dl>
			<Button variant="outline" size="sm" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

function ConnectionRow({
	connection,
	url,
	enabled,
	onSecret,
}: {
	connection: GitHubConnection;
	url: string;
	enabled: boolean;
	onSecret: (secret: NewSecret) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const members = useMembersById();
	const [action, setAction] = useState<"rotate" | "delete" | null>(null);
	const creator = members.get(connection.createdBy);
	const name = connection.lastRepository ?? "Waiting for the first delivery";

	async function rotate() {
		const result = await rotateGitHubSecret({ data: { workspace: slug, id: connection.id } });
		if (!result.ok) {
			toast.error("Could not make a new secret", { description: result.message });
			return;
		}
		onSecret({ url, secret: result.value, rotated: true });
	}

	async function remove() {
		const result = await deleteGitHubConnection({ data: { workspace: slug, id: connection.id } });
		if (!result.ok) {
			toast.error("Could not delete the connection", { description: result.message });
			return;
		}
		toast.success("Connection deleted");
		await router.invalidate();
	}

	return (
		<li className="flex items-start gap-3 px-4 py-3">
			<div className="min-w-0 flex-1 space-y-1">
				<p className="truncate text-sm font-medium">{name}</p>
				<p className="text-xs text-muted-foreground">
					{connection.lastDeliveryAt !== null ? (
						<>
							{EVENT_LABELS[connection.lastEvent ?? ""] ?? connection.lastEvent} received{" "}
							<time
								dateTime={new Date(connection.lastDeliveryAt).toISOString()}
								title={formatDateTime(connection.lastDeliveryAt)}
							>
								{formatRelative(connection.lastDeliveryAt)}
							</time>
						</>
					) : (
						<>
							Added{" "}
							<time
								dateTime={new Date(connection.createdAt).toISOString()}
								title={formatDateTime(connection.createdAt)}
							>
								{formatRelative(connection.createdAt)}
							</time>
							{creator && ` by ${creator.name}`}
						</>
					)}
				</p>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="size-8" aria-label={`More for ${name}`}>
						<Ellipsis />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={() => copy(url, "Payload URL")}>
						Copy payload URL
					</DropdownMenuItem>
					{enabled && (
						<DropdownMenuItem onSelect={() => setAction("rotate")}>New secret</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() => setAction("delete")}
					>
						Delete connection
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{action === "rotate" && (
				<ConfirmDialog
					title="Make a new secret?"
					confirmLabel="Make a new secret"
					onConfirm={rotate}
					onClose={() => setAction(null)}
				>
					Deliveries signed with the old secret are refused from now on, until the webhook on GitHub
					has the new one.
				</ConfirmDialog>
			)}
			{action === "delete" && (
				<ConfirmDialog
					title="Delete this connection?"
					confirmLabel="Delete"
					onConfirm={remove}
					onClose={() => setAction(null)}
				>
					Track stops listening to its webhook. Pull requests it linked stay on their issues; delete
					the webhook on GitHub too.
				</ConfirmDialog>
			)}
		</li>
	);
}
