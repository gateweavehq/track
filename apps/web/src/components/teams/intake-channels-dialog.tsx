import type { Team } from "@gateweave/track-protocol";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Copy } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { useWorkspace } from "#/components/workspace/context";
import { getIntakeOptions, intakeFormUrl } from "#/lib/intake";
import { intakeAddress } from "#/lib/intake-email";
import { send } from "#/lib/mutations";
import { useTeams } from "#/lib/queries";

type IntakeOptions = Awaited<ReturnType<typeof getIntakeOptions>>;

/**
 * Turns a team's ways in for people without an account on or off, and shares them: a public
 * request form, and an email address. Each files what it gets into the team's intake. Admins
 * only; the server checks again.
 */
export function IntakeChannelsDialog({
	team: initial,
	onClose,
}: {
	team: Team;
	onClose: () => void;
}) {
	const client = useSyncClient();
	const { id: workspaceId } = useWorkspace();
	// The live team, so a link or address shows up once the server has made it.
	const team = useTeams().find((each) => each.id === initial.id) ?? initial;
	// Offline, the server cannot say what it allows; the switches work all the same.
	const [options, setOptions] = useState<IntakeOptions | null>(null);
	useEffect(() => {
		let current = true;
		getIntakeOptions()
			.then((value) => current && setOptions(value))
			.catch(() => current && setOptions(null));
		return () => {
			current = false;
		};
	}, []);

	const update = (patch: { intakeForm?: boolean; intakeEmail?: boolean }) =>
		send(client, { name: "team.update", args: { id: team.id, patch } });
	const formUrl = team.intakeFormKey ? intakeFormUrl(workspaceId, team.intakeFormKey) : null;
	const domain = options?.emailDomain;
	const address =
		team.intakeEmailKey && domain ? intakeAddress(workspaceId, team.intakeEmailKey, domain) : null;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Intake for {team.name}</DialogTitle>
					<DialogDescription>
						People without an account can send requests to the team's intake, where someone on the
						team accepts or declines each one.
					</DialogDescription>
				</DialogHeader>
				<Channel
					title="Request form"
					description="Anyone with the link can fill in a form."
					value={formUrl}
					valueLabel="Form link"
					on={team.intakeFormKey !== null}
					offText="The form is off."
					renewLabel="New link"
					unavailable={
						options?.forms === false &&
						"This server takes no requests through forms until its admin sets Turnstile's keys (TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY). See the self-hosting guide."
					}
					onTurn={(intakeForm) => update({ intakeForm })}
				/>
				<Channel
					title="Email address"
					description="Email sent to it, or forwarded from your support address, becomes a request."
					value={address}
					valueLabel="Intake address"
					on={team.intakeEmailKey !== null}
					offText="The address is off."
					renewLabel="New address"
					unavailable={
						options !== null &&
						domain === null &&
						"This server takes no email until its admin routes a domain to it and sets INTAKE_EMAIL_DOMAIN. See the self-hosting guide."
					}
					onTurn={(intakeEmail) => update({ intakeEmail })}
				/>
			</DialogContent>
		</Dialog>
	);
}

function Channel({
	title,
	description,
	value,
	valueLabel,
	on,
	offText,
	renewLabel,
	unavailable,
	onTurn,
}: {
	title: string;
	description: string;
	value: string | null;
	valueLabel: string;
	on: boolean;
	offText: string;
	renewLabel: string;
	unavailable: ReactNode;
	onTurn: (on: boolean) => void;
}) {
	const heading = useId();

	async function copy() {
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${valueLabel} copied`);
		} catch {
			toast.error("Could not copy it", { description: value });
		}
	}

	return (
		<section aria-labelledby={heading} className="space-y-2 rounded-md border p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="space-y-0.5">
					<h3 id={heading} className="text-sm font-medium">
						{title}
					</h3>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
				<div className="flex shrink-0 gap-1">
					{on ? (
						<>
							{/* Keyed, so no button turns into another and fades between their colors. */}
							<Button key="renew" variant="ghost" size="sm" onClick={() => onTurn(true)}>
								{renewLabel}
							</Button>
							<Button key="off" variant="outline" size="sm" onClick={() => onTurn(false)}>
								Turn off
							</Button>
						</>
					) : (
						<Button key="on" size="sm" onClick={() => onTurn(true)}>
							Turn on
						</Button>
					)}
				</div>
			</div>
			{unavailable && (
				<p role="alert" className="rounded-md bg-muted/60 px-3 py-2 text-xs">
					{unavailable}
				</p>
			)}
			{value ? (
				<div className="flex items-center gap-2">
					<input
						readOnly
						value={value}
						aria-label={valueLabel}
						onFocus={(event) => event.currentTarget.select()}
						className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs"
					/>
					<Button variant="outline" size="sm" onClick={copy}>
						<Copy />
						Copy
					</Button>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					{on ? "It is on, but this server does not say where." : offText}
				</p>
			)}
			{value && (
				<p className="text-xs text-muted-foreground">
					A new one retires this one, as turning it off does.
				</p>
			)}
		</section>
	);
}
