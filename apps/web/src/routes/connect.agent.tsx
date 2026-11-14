import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { LegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { approveAgentConnection, getConnectOffer, getConnectTeams } from "#/lib/connect";
import { getLegalLinks, getSession } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// The page another server sends an admin to, to add an agent member and its webhook in one step
// ("Connecting an agent in one step" in docs/architecture.md). Its query is read raw, by the server:
// the router would turn a value that looks like a number into one, and `state` must come back as
// it was sent.
export const Route = createFileRoute("/connect/agent")({
	validateSearch: z.looseObject({}),
	beforeLoad: async ({ location }) => {
		if (!(await getSession()))
			throw redirect({ to: "/login", search: { redirect: location.href } });
	},
	loader: async ({ location }) => {
		const [offer, legal] = await Promise.all([
			getConnectOffer({ data: location.searchStr }),
			getLegalLinks(),
		]);
		return { offer, legal, query: location.searchStr };
	},
	component: ConnectPage,
});

/** What each event is, in words, for the line that says what is sent. */
const EVENT_WORDS: Record<string, string> = {
	"issue.created": "an issue is created",
	"issue.updated": "an issue changes",
	"issue.deleted": "an issue is deleted",
	"comment.created": "a comment is added",
	"comment.updated": "a comment changes",
	"comment.deleted": "a comment is deleted",
	"proposal.created": "a change is proposed",
	"proposal.updated": "a proposal changes",
	"proposal.accepted": "a proposal is accepted",
	"proposal.dismissed": "a proposal is dismissed",
	"relation.created": "two issues are linked",
	"relation.deleted": "a link between issues is removed",
	"project_update.created": "a project update is posted",
	"project_update.updated": "a project update changes",
	"project_update.deleted": "a project update is deleted",
};

function ConnectPage() {
	const { offer, query } = Route.useLoaderData();
	useDocumentTitle("Connect an agent");

	if (!offer.ok) {
		return (
			<Card title="This request cannot be approved">
				<p className="text-sm text-muted-foreground">{offer.problem}</p>
				<Button asChild variant="outline" className="w-full">
					<Link to="/">Go to Gateweave Track</Link>
				</Button>
			</Card>
		);
	}
	return <Offer offer={offer} query={query} />;
}

type OkOffer = Extract<Awaited<ReturnType<typeof getConnectOffer>>, { ok: true }>;
type Team = { id: string; key: string; name: string };

function Offer({ offer, query }: { offer: OkOffer; query: string }) {
	const [workspace, setWorkspace] = useState(offer.workspaces[0]?.slug ?? "");
	const [teams, setTeams] = useState<Team[] | null>(null);
	const [teamId, setTeamId] = useState("");
	const [name, setName] = useState(offer.suggestedName);
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// The teams of the chosen workspace, read after the server has checked the person is its admin.
	useEffect(() => {
		let current = true;
		setTeams(null);
		setTeamId("");
		getConnectTeams({ data: workspace })
			.then((found) => current && setTeams(found ?? []))
			.catch(() => current && setTeams([]));
		return () => {
			current = false;
		};
	}, [workspace]);

	async function decide(decision: "allow" | "cancel") {
		setPending(true);
		setProblem(null);
		try {
			const answer = await approveAgentConnection({
				data: { query, decision, workspace, teamId: teamId || null, name },
			});
			// A fetch and then a navigation: a form that redirects away is blocked by the page's CSP.
			if (answer.ok) window.location.assign(answer.redirect);
			else {
				setPending(false);
				setProblem(answer.message);
			}
		} catch {
			setPending(false);
			setProblem("Something went wrong. Nothing was made. Try again.");
		}
	}

	const events = offer.events.map((event) => EVENT_WORDS[event] ?? event);
	const team = teams?.find((each) => each.id === teamId);
	return (
		<Card title="Add an agent to a workspace?">
			<div className="space-y-2">
				<p className="break-all text-2xl font-semibold tracking-tight">{offer.asker}</p>
				<p className="text-sm text-muted-foreground">
					wants to add an agent member to a workspace of yours and be sent its issues.
				</p>
				{offer.known ? (
					<p className="text-sm text-muted-foreground">
						This address is one this Track server lists as known.
					</p>
				) : (
					<p className="text-sm font-medium text-destructive">
						Allow this only if you run or trust this address.
					</p>
				)}
			</div>

			<div className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="connect-workspace">Workspace</Label>
					<select
						id="connect-workspace"
						className={SELECT}
						value={workspace}
						onChange={(event) => setWorkspace(event.target.value)}
						disabled={pending}
					>
						{offer.workspaces.map((each) => (
							<option key={each.slug} value={each.slug}>
								{each.name}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						Only workspaces you own or are an admin of.
					</p>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="connect-team">Send issues from</Label>
					<select
						id="connect-team"
						className={SELECT}
						value={teamId}
						onChange={(event) => setTeamId(event.target.value)}
						disabled={pending || teams === null}
					>
						<option value="">All teams</option>
						{teams?.map((each) => (
							<option key={each.id} value={each.id}>
								{each.name} ({each.key})
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="connect-name">Agent name</Label>
					<Input
						id="connect-name"
						value={name}
						maxLength={80}
						onChange={(event) => setName(event.target.value)}
						disabled={pending}
					/>
				</div>
			</div>

			<div className="space-y-2 text-sm text-muted-foreground">
				<p>If you allow it, Track makes:</p>
				<ul className="list-disc space-y-1.5 pl-5">
					<li>
						An agent member named <span className="text-foreground">{name.trim() || "…"}</span> in
						the workspace, with a key that only {offer.asker} receives.
					</li>
					<li>
						A webhook to <span className="break-all text-foreground">{offer.asker}</span>, for{" "}
						{team ? `issues of ${team.name}` : "every team"}, sent when {listOf(events)}. It is set
						up for that agent, so its own changes are not sent back.
					</li>
				</ul>
				<p>
					An agent member can read the workspace and change issues as a member does. It cannot
					manage the workspace: no people, settings, webhooks or other agents. You can delete it and
					the webhook in the workspace's settings at any time.
				</p>
			</div>

			{problem && (
				<p role="alert" className="text-sm text-destructive">
					{problem}
				</p>
			)}
			<div className="space-y-2">
				<Button
					className="w-full"
					onClick={() => decide("allow")}
					disabled={pending || !workspace || !name.trim()}
				>
					Allow
				</Button>
				<Button
					variant="ghost"
					className="w-full"
					onClick={() => decide("cancel")}
					disabled={pending}
				>
					Cancel
				</Button>
			</div>
		</Card>
	);
}

const SELECT =
	"h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

/** "a, b and c". */
function listOf(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	const { legal } = Route.useLoaderData();
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-md space-y-6">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{children}
				<LegalLinks links={legal} />
			</div>
		</main>
	);
}
