import {
	KEYS_PER_SOURCE,
	SOURCE_PRODUCTS,
	SOURCE_THRESHOLDS,
	type Source,
	sourceSettingsSchema,
} from "@gateweave/track-protocol";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { useActiveMembers, useTeams } from "#/lib/queries";
import { changeSource, getSourceSettings } from "#/lib/sources";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/sources")({
	loader: async ({ params }) => {
		const settings = await getSourceSettings({ data: params.workspace });
		if (!settings) throw notFound();
		return settings;
	},
	component: SourcesPage,
});

type Action = Parameters<typeof changeSource>[0]["data"]["action"];
type SourceKey = { id: string; start: string; sourceId: string };
type Run = (action: Action) => Promise<boolean>;
const selectClass = "block h-9 w-full rounded-md border border-input bg-background px-3";

function SourcesPage() {
	const { workspace } = Route.useParams();
	return <SourceSettings key={workspace} />;
}

function SourceSettings() {
	useDocumentTitle("Sources");
	const admin = isAdmin(useMyRole());
	const { workspace } = Route.useParams();
	const { sources, keys } = Route.useLoaderData();
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);
	async function run(action: Action) {
		setBusy(true);
		try {
			const result = await changeSource({ data: { workspace, action } });
			if (!result.ok) {
				toast.error(result.message);
				return false;
			}
			setSecret(result.value.secret ?? "");
			await router.invalidate();
			return true;
		} catch {
			toast.error("Could not save the source. Reload to check its settings.");
			return false;
		} finally {
			setBusy(false);
		}
	}
	if (!admin) throw notFound();
	return (
		<fieldset disabled={busy} className="space-y-5">
			<header className="flex items-center justify-between">
				<h2 className="text-lg font-semibold">Sources</h2>
				<Button onClick={() => setAdding(true)} disabled={adding}>
					Add source
				</Button>
			</header>
			{secret && (
				<section className="space-y-2 rounded-md border p-4">
					<label htmlFor="source-secret">
						Source key
						<Input id="source-secret" readOnly value={secret} />
					</label>
					<p className="text-sm text-muted-foreground">
						Copy this key now. You can only see it once.
					</p>
					<Button variant="outline" onClick={() => setSecret("")}>
						Done
					</Button>
				</section>
			)}
			{adding && <SourceForm run={run} done={() => setAdding(false)} />}
			{sources.map((source) => (
				<SourceRow
					key={source.id}
					source={source}
					keys={keys.filter((key) => key.sourceId === source.id)}
					run={run}
				/>
			))}
		</fieldset>
	);
}

function SourceForm({ source, run, done }: { source?: Source; run: Run; done: () => void }) {
	const teams = useTeams();
	const nameId = useId();
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const fields = new FormData(event.currentTarget);
		const settings = sourceSettingsSchema.safeParse({
			name: fields.get("name"),
			product: fields.get("product"),
			teamId: fields.get("teamId"),
			lowestSeverity: fields.get("threshold"),
			closeWhenCleared: fields.has("close"),
			linkOrigins:
				source?.linkOrigins ??
				String(fields.get("links") ?? "")
					.trim()
					.split(/\s+/)
					.filter(Boolean),
		});
		if (!settings.success) {
			toast.error(settings.error.issues[0]?.message ?? "Invalid source settings");
			return;
		}
		const { linkOrigins, ...input } = settings.data;
		const saved = await run(
			source
				? { kind: "update", id: source.id, input }
				: { kind: "create", input: { ...input, linkOrigins } },
		);
		if (saved) done();
	}
	return (
		<form className="grid gap-4 rounded-md border p-4 text-sm" onSubmit={submit}>
			<label htmlFor={nameId}>
				Name
				<Input id={nameId} name="name" defaultValue={source?.name} required />
			</label>
			<label>
				Product
				<select name="product" className={selectClass} defaultValue={source?.product ?? "other"}>
					{SOURCE_PRODUCTS.map((product) => (
						<option key={product}>{product}</option>
					))}
				</select>
			</label>
			<label>
				Team
				<select name="teamId" required className={selectClass} defaultValue={source?.teamId}>
					{teams.map((team) => (
						<option key={team.id} value={team.id}>
							{team.name}
						</option>
					))}
				</select>
			</label>
			<label>
				Lowest severity
				<select
					name="threshold"
					className={selectClass}
					defaultValue={source?.lowestSeverity ?? "high"}
				>
					{SOURCE_THRESHOLDS.map((severity) => (
						<option key={severity}>{severity}</option>
					))}
				</select>
			</label>
			<label className="flex items-center gap-2">
				<input type="checkbox" name="close" defaultChecked={source?.closeWhenCleared} />
				Close when cleared
			</label>
			<label>
				Link origins (one per line)
				<textarea
					name="links"
					className="block w-full rounded-md border p-2"
					readOnly={Boolean(source)}
					defaultValue={source?.linkOrigins.join("\n")}
				/>
			</label>
			<div className="flex gap-2">
				<Button type="submit" disabled={!teams.length}>
					{source ? "Save changes" : "Create source"}
				</Button>
				<Button type="button" variant="outline" onClick={done}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function SourceRow({ source, keys, run }: { source: Source; keys: SourceKey[]; run: Run }) {
	const [step, setStep] = useState<"edit" | "assign" | "delete" | null>(null);
	const members = useActiveMembers();
	const { id, name, paused } = source;
	const toggle = () => run({ kind: "pause", id, paused: !paused });
	return (
		<section aria-label={name} className="space-y-3 rounded-md border p-4">
			<h3 className="font-medium">
				{name}
				{paused && " (paused)"}
			</h3>
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" onClick={() => setStep("edit")}>
					Edit
				</Button>
				<Button variant="outline" onClick={() => setStep("assign")}>
					Set assignee
				</Button>
				<Button variant="outline" onClick={toggle}>
					{paused ? "Resume" : "Pause"}
				</Button>
				<Button variant="outline" onClick={() => setStep("delete")}>
					Delete
				</Button>
			</div>
			{step === "edit" && <SourceForm source={source} run={run} done={() => setStep(null)} />}
			{step === "assign" && (
				<form
					className="space-y-2"
					onSubmit={async (event) => {
						event.preventDefault();
						const assigneeId =
							String(new FormData(event.currentTarget).get("assignee") ?? "") || null;
						if (await run({ kind: "assign", id, assigneeId })) setStep(null);
					}}
				>
					<p>Anything this source reports becomes a task for this agent.</p>
					<label>
						Assignee
						<select className={selectClass} name="assignee" defaultValue={source.assigneeId ?? ""}>
							<option value="">Unassigned</option>
							{members
								.filter((member) => member.role === "agent")
								.map((member) => (
									<option key={member.id} value={member.id}>
										{member.name}
									</option>
								))}
						</select>
					</label>
					<Button type="submit">Save assignee</Button>
				</form>
			)}
			{step === "delete" && (
				<div className="space-y-2">
					<p>Delete this source, its keys and its signals? Its issues stay in Track.</p>
					<Button variant="destructive" onClick={() => run({ kind: "delete", id })}>
						Delete source
					</Button>
					<Button variant="ghost" onClick={() => setStep(null)}>
						Cancel
					</Button>
				</div>
			)}
			<h4 className="text-sm font-medium">Keys</h4>
			<ul>
				{keys.map((key) => (
					<li key={key.id} className="flex items-center gap-3">
						<code>{key.start}…</code>
						<Button variant="ghost" onClick={() => run({ kind: "revokeKey", id, keyId: key.id })}>
							Revoke
						</Button>
					</li>
				))}
			</ul>
			<Button
				variant="outline"
				disabled={keys.length >= KEYS_PER_SOURCE}
				onClick={() => run({ kind: "makeKey", id })}
			>
				Make key
			</Button>
		</section>
	);
}
