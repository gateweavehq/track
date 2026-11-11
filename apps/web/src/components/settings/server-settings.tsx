import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { authFailure } from "#/lib/auth-failure";
import { MAX_ALLOW_NOTE } from "#/lib/sign-up-allow";

// "Who runs this server" in docs/architecture.md. Only the owner's account page shows this, and the
// paths it calls answer anyone else with a 404.

interface Entry {
	entry: string;
	note: string | null;
	addedAt: number;
	hasAccount: boolean;
}

interface Settings {
	signUp: "open" | "closed";
	trustProvider: boolean;
	provider: string | null;
	total: number;
	matching: number;
	limit: number;
	entries: Entry[];
}

async function send(path: string, body: object) {
	const result = await authClient.$fetch<Record<string, unknown>>(path, { method: "POST", body });
	return result.error ? authFailure(result.error) : null;
}

/** What the owner decides about who may make an account here, and the list that says. */
export function ServerSettings() {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (search: string) => {
		const result = await authClient.$fetch<Settings>("/deployment/get", {
			query: search ? { q: search } : {},
		});
		if (result.error) setError(authFailure(result.error));
		else setSettings(result.data);
	}, []);

	// Typing in the search box asks the server, which holds more than a page of the list.
	useEffect(() => {
		const timer = setTimeout(() => load(query.trim()), query ? 250 : 0);
		return () => clearTimeout(timer);
	}, [load, query]);

	const reload = () => load(query.trim());

	return (
		<section aria-labelledby="server-heading" className="space-y-4">
			<h2 id="server-heading" className="text-sm font-semibold">
				This server
			</h2>
			<div className="space-y-6 rounded-lg border p-4">
				<p className="text-sm text-muted-foreground">
					You run this server, so only you see this. It decides who may make a new account here.
					People who already have one are not affected.
				</p>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{settings === null ? (
					!error && <p className="text-sm text-muted-foreground">Loading…</p>
				) : (
					<>
						<SignUp settings={settings} reload={reload} />
						{settings.provider && <TrustProvider settings={settings} reload={reload} />}
						<List
							settings={settings}
							query={query}
							onQuery={setQuery}
							reload={reload}
							provider={settings.provider}
						/>
					</>
				)}
			</div>
		</section>
	);
}

function SignUp({ settings, reload }: { settings: Settings; reload: () => Promise<void> }) {
	const name = useId();
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function choose(signUp: Settings["signUp"]) {
		if (signUp === settings.signUp) return;
		setError(null);
		setSaved(false);
		const failure = await send("/deployment/sign-up", { signUp });
		if (failure) setError(failure);
		else setSaved(true);
		await reload();
	}

	const options: { value: Settings["signUp"]; label: string; words: string }[] = [
		{
			value: "open",
			label: "Open",
			words: "Anyone who can reach this address may make an account.",
		},
		{
			value: "closed",
			label: "By invitation",
			words:
				"Only people on the list below, and people invited to a workspace, may make an account. Everyone else is refused.",
		},
	];

	return (
		<fieldset className="space-y-3">
			<legend className="text-sm font-medium">Sign-up</legend>
			{options.map((option) => (
				<div key={option.value} className="flex items-start gap-3">
					<input
						type="radio"
						id={`${name}-${option.value}`}
						name={name}
						checked={settings.signUp === option.value}
						onChange={() => choose(option.value)}
						className="mt-1 size-4 accent-primary"
					/>
					<div className="space-y-0.5">
						<Label htmlFor={`${name}-${option.value}`}>{option.label}</Label>
						<p className="text-sm text-muted-foreground">{option.words}</p>
					</div>
				</div>
			))}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{saved && (
				<p role="status" className="text-sm text-muted-foreground">
					Saved.
				</p>
			)}
		</fieldset>
	);
}

function TrustProvider({ settings, reload }: { settings: Settings; reload: () => Promise<void> }) {
	const id = useId();
	const [error, setError] = useState<string | null>(null);
	const provider = settings.provider ?? "";

	async function toggle(trust: boolean) {
		setError(null);
		const failure = await send("/deployment/trust-provider", { trust });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<div className="flex items-start gap-3">
			<Checkbox
				id={id}
				checked={settings.trustProvider}
				onCheckedChange={(checked) => toggle(checked === true)}
				className="mt-1"
			/>
			<div className="space-y-0.5">
				<Label htmlFor={id}>{`Trust ${provider}`}</Label>
				<p className="text-sm text-muted-foreground">
					{`While sign-up is by invitation, anyone who signs in through ${provider} may make an account, because it keeps a list of its own. Signing in with GitHub is never trusted this way.`}
				</p>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}

function List({
	settings,
	query,
	onQuery,
	reload,
	provider,
}: {
	settings: Settings;
	query: string;
	onQuery: (query: string) => void;
	reload: () => Promise<void>;
	provider: string | null;
}) {
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const searching = query.trim() !== "";

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const formElement = event.currentTarget;
		const form = new FormData(formElement);
		const entry = String(form.get("entry")).trim();
		setPending(true);
		setError(null);
		setAdded(null);
		const failure = await send("/deployment/allow/add", {
			entry,
			note: String(form.get("note") ?? ""),
		});
		setPending(false);
		if (failure) {
			setError(failure);
			return;
		}
		formElement.reset();
		setAdded(`${entry.toLowerCase()} is on the list.`);
		await reload();
	}

	async function remove(entry: string) {
		setError(null);
		setAdded(null);
		const failure = await send("/deployment/allow/remove", { entry });
		if (failure) setError(failure);
		await reload();
	}

	return (
		<div className="space-y-4">
			<h3 className="text-sm font-medium">People who may make an account</h3>
			<p className="text-sm text-muted-foreground">
				Add an email address, or a domain with an @ in front, such as @example.com. A domain covers
				addresses at exactly that domain, not at its subdomains. The list holds addresses of people
				who may have no account yet, so it is as private as the accounts are.
				{provider ? ` Anyone ${provider} lets in is also let in if you trust it above.` : ""}
			</p>
			<form onSubmit={onSubmit} className="space-y-3">
				<div className="space-y-2">
					<Label htmlFor="allow-entry">Email address or @domain</Label>
					<Input
						id="allow-entry"
						name="entry"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						maxLength={254}
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="allow-note">Note (optional)</Label>
					<Input
						id="allow-note"
						name="note"
						autoComplete="off"
						maxLength={MAX_ALLOW_NOTE}
						placeholder="From the waitlist"
					/>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{added && (
					<p role="status" className="text-sm break-words text-muted-foreground">
						{added}
					</p>
				)}
				<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
					Add to the list
				</LiveButton>
			</form>

			<div className="space-y-2">
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<Label htmlFor="allow-search">Search the list</Label>
					<p role="status" className="text-xs text-muted-foreground">
						{searching
							? `${settings.matching} of ${settings.total} ${settings.total === 1 ? "entry" : "entries"}`
							: `${settings.total} ${settings.total === 1 ? "entry" : "entries"} of at most ${settings.limit}`}
					</p>
				</div>
				<Input
					id="allow-search"
					type="search"
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
				/>
			</div>

			{settings.entries.length > 0 ? (
				<>
					<ul
						aria-label="People who may make an account"
						className="divide-y rounded-lg border text-sm"
					>
						{settings.entries.map((item) => (
							<li
								key={item.entry}
								className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
							>
								<div className="min-w-0 space-y-0.5">
									<p className="font-medium break-all">{item.entry}</p>
									{item.note && <p className="break-words text-muted-foreground">{item.note}</p>}
									<p className="text-xs text-muted-foreground">
										{`Added ${new Date(item.addedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}. `}
										{accountWords(item)}
									</p>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="shrink-0"
									aria-label={`Remove ${item.entry} from the list`}
									onClick={() => remove(item.entry)}
								>
									Remove
								</Button>
							</li>
						))}
					</ul>
					{settings.matching > settings.entries.length && (
						<p className="text-xs text-muted-foreground">
							{`Showing the newest ${settings.entries.length}. Search to find the rest.`}
						</p>
					)}
				</>
			) : (
				<p className="text-sm text-muted-foreground">
					{searching ? "Nothing on the list matches." : "Nobody is on the list yet."}
				</p>
			)}
		</div>
	);
}

/** Whether the entry has led to an account, for the owner to see who has not come yet. */
function accountWords({ entry, hasAccount }: Entry): string {
	if (entry.startsWith("@")) {
		return hasAccount
			? "Someone at this domain has an account."
			: "Nobody at this domain has an account yet.";
	}
	return hasAccount ? "Has an account." : "No account yet.";
}
