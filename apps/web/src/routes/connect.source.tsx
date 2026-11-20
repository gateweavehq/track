import { SOURCE_THRESHOLDS, type SourceThreshold } from "@gateweave/track-protocol";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { LegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import {
	approveSourceConnection,
	getSourceConnectChoices,
	getSourceConnectOffer,
	rawConnectQuery,
} from "#/lib/connect";
import { getLegalLinks, getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/connect/source")({
	validateSearch: z.looseObject({}),
	beforeLoad: async ({ location }) => {
		if (!(await getSession()))
			throw redirect({ to: "/login", search: { redirect: location.pathname + rawConnectQuery() } });
	},
	loader: async () => {
		const query = rawConnectQuery();
		const [offer, legal] = await Promise.all([
			getSourceConnectOffer({ data: query }),
			getLegalLinks(),
		]);
		return { offer, legal, query };
	},
	component: ConnectSourcePage,
});

function ConnectSourcePage() {
	const { offer, legal, query } = Route.useLoaderData();
	useDocumentTitle("Connect a source");
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-md space-y-6">
				<h1 className="text-xl font-semibold tracking-tight">
					{offer.ok ? "Connect a source to a workspace?" : "This request cannot be approved"}
				</h1>
				{offer.ok ? (
					<Offer key={query} offer={offer} query={query} />
				) : (
					<>
						<p className="text-sm text-muted-foreground">{offer.problem}</p>
						<Button asChild variant="outline" className="w-full">
							<Link to="/">Go to Gateweave Track</Link>
						</Button>
					</>
				)}
				<LegalLinks links={legal} />
			</div>
		</main>
	);
}

type OkOffer = Extract<Awaited<ReturnType<typeof getSourceConnectOffer>>, { ok: true }>;
const selectClass = "block h-9 w-full rounded-md border border-input bg-background px-3";
const prominent = "break-all text-2xl font-semibold tracking-tight";

function Offer({ offer, query }: { offer: OkOffer; query: string }) {
	const [workspace, setWorkspace] = useState(offer.workspaces[0]?.slug ?? "");
	const [choices, setChoices] = useState<Awaited<ReturnType<typeof getSourceConnectChoices>>>(null);
	const [teamId, setTeamId] = useState("");
	const [assigneeId, setAssigneeId] = useState("");
	const [lowestSeverity, setLowestSeverity] = useState<SourceThreshold>("high");
	const [closeWhenCleared, setCloseWhenCleared] = useState(offer.product === "guard");
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState("");

	useEffect(() => {
		let current = true;
		getSourceConnectChoices({ data: workspace })
			.then((result) => {
				if (!current) return;
				setChoices(result);
				setTeamId(result?.teams[0]?.id ?? "");
				if (!result) setProblem("Could not load this workspace.");
			})
			.catch(() => {
				if (current) setProblem("Could not load this workspace.");
			});
		return () => {
			current = false;
		};
	}, [workspace]);

	async function decide(decision: "allow" | "cancel") {
		setPending(true);
		setProblem("");
		try {
			const answer = await approveSourceConnection({
				data: {
					query,
					decision,
					workspace,
					teamId,
					lowestSeverity,
					closeWhenCleared,
					assigneeId: assigneeId || null,
				},
			});
			if (answer.ok) {
				window.location.assign(answer.redirect);
				return;
			}
			setProblem(answer.message);
		} catch {
			if (decision === "allow") {
				setProblem(
					"We couldn't tell whether this went through. Look under Sources in the workspace's settings before trying again.",
				);
				return;
			}
			setProblem("Something went wrong. Try again.");
		}
		setPending(false);
	}

	return (
		<>
			<div>
				<p>Asking address</p>
				<p className={prominent}>{offer.asker}</p>
				{offer.known ? (
					<p>This is a known address, not verified as the named product.</p>
				) : (
					<p className="text-destructive">Allow this only if you run or trust this address.</p>
				)}
			</div>
			<dl className="space-y-2">
				<dt>Product</dt>
				<dd className={prominent}>{offer.product}</dd>
				<dt>Source name</dt>
				<dd className={prominent}>{offer.name}</dd>
				<dt>Link origins on issues</dt>
				{offer.linkOrigins.map((link) => (
					<dd key={link}>
						<p className={prominent}>{link}</p>
						{offer.otherLinkOrigins.includes(link) && (
							<p className="text-destructive">Links to {link} lead away from the asking address.</p>
						)}
					</dd>
				))}
			</dl>
			<p>
				The asking server will receive a key to file, clear and reopen signals in the team you
				choose, within Track's daily limits.
			</p>
			<fieldset className="grid gap-4 text-sm" disabled={pending}>
				<label>
					Workspace
					<select
						className={selectClass}
						value={workspace}
						onChange={(e) => {
							setTeamId("");
							setAssigneeId("");
							setChoices(null);
							setProblem("");
							setWorkspace(e.target.value);
						}}
					>
						{offer.workspaces.map((each) => (
							<option key={each.slug} value={each.slug}>
								{each.name}
							</option>
						))}
					</select>
				</label>
				<label>
					Team
					<select
						className={selectClass}
						value={teamId}
						disabled={!choices?.teams.length}
						onChange={(e) => setTeamId(e.target.value)}
					>
						{choices?.teams.map((each) => (
							<option key={each.id} value={each.id}>
								{each.name} ({each.key})
							</option>
						))}
					</select>
				</label>
				{choices?.teams.length === 0 && <p>This workspace has no team to receive signals.</p>}
				<label>
					Lowest severity
					<select
						className={selectClass}
						value={lowestSeverity}
						onChange={(e) => {
							const severity = SOURCE_THRESHOLDS.find((each) => each === e.target.value);
							if (severity) setLowestSeverity(severity);
						}}
					>
						{SOURCE_THRESHOLDS.map((severity) => (
							<option key={severity}>{severity}</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={closeWhenCleared}
						onChange={(e) => setCloseWhenCleared(e.target.checked)}
					/>
					Close when cleared
				</label>
				<label>
					Assign issues to
					<select
						className={selectClass}
						value={assigneeId}
						disabled={!choices}
						onChange={(e) => setAssigneeId(e.target.value)}
					>
						<option value="">No agent</option>
						{choices?.agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>
				</label>
				{assigneeId && (
					<p className="text-destructive">
						The source's text reaches the assigned agent and could contain instructions that
						influence what it does.
					</p>
				)}
			</fieldset>
			{problem && (
				<p role="alert" className="text-sm text-destructive">
					{problem}
				</p>
			)}
			<div className="space-y-2">
				<Button className="w-full" onClick={() => decide("allow")} disabled={pending || !teamId}>
					Allow
				</Button>
				<Button
					className="w-full"
					variant="ghost"
					onClick={() => decide("cancel")}
					disabled={pending}
				>
					Cancel
				</Button>
			</div>
		</>
	);
}
