import {
	SOURCE_PRODUCTS,
	SOURCE_THRESHOLDS,
	type Source,
	sourceSettingsSchema,
} from "@gateweave/track-protocol";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { useTeams } from "#/lib/queries";
import type { changeSource } from "#/lib/sources";

export type SourceAction = Parameters<typeof changeSource>[0]["data"]["action"];
export type Run = (action: SourceAction) => Promise<boolean>;
export const selectClass = "block h-9 w-full rounded-md border border-input bg-background px-3";

/**
 * The key to keep on screen after an action. A key is shown once, so only a new one replaces it,
 * and only "Done" puts it away: any other answer leaves it for the admin to copy.
 */
export function shownKey(shown: string, answer: { secret?: string }): string {
	return answer.secret ?? shown;
}

/** Makes a source, or changes one: an update sends only the fields the person changed. */
export function SourceForm({
	source: live,
	run,
	done,
}: {
	source?: Source;
	run: Run;
	done: () => void;
}) {
	const teams = useTeams();
	const nameId = useId();
	// The fields show the settings as they were when the form opened, and a save sends only what
	// the person changed from those. Another admin's change meanwhile is neither shown nor undone.
	const [source] = useState(live);
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
				? {
						kind: "update",
						id: source.id,
						input: Object.fromEntries(
							Object.entries(input).filter(
								([key, value]) => source[key as keyof typeof input] !== value,
							),
						),
					}
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
