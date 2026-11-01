import type { Issue, Team } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { Link } from "@tanstack/react-router";
import { Ban, Check, Inbox, Link2, Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { RequestFormDialog } from "#/components/teams/request-form-dialog";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	isAdmin,
	useMyRole,
	useWorkspace,
	useWorkspaceActions,
} from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { actorName } from "#/lib/actors";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { issueKey } from "#/lib/issues";
import { send } from "#/lib/mutations";
import { useIntakeIssues, useMembersById, useStatuses, useTeamStatuses } from "#/lib/queries";
import { statusOf } from "#/lib/statuses";
import { StatusIcon } from "./meta";

/** Accepting keeps the request's status; it can be changed first, like any issue's. */
function useAccept() {
	const client = useSyncClient();
	return (issue: Issue) => send(client, { name: "issue.accept", args: { id: issue.id } });
}

/** Whether the team can decline: a request is declined into its first canceled status. */
function useCanDecline(teamId: string): boolean {
	return useTeamStatuses(teamId).some((status) => status.category === "canceled");
}

/** Asks for an optional reply, then declines the request into the team's canceled status. */
function DeclineDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
	const client = useSyncClient();
	const [reply, setReply] = useState("");

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const body = reply.trim();
		const sent = send(client, {
			name: "issue.decline",
			args: { id: issue.id, ...(body && { reply: { id: uuidv7(), body } }) },
		});
		if (sent) onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Decline request</DialogTitle>
						<DialogDescription>
							It is canceled and leaves the intake. A reply is posted as a comment, which whoever
							filed it hears of.
						</DialogDescription>
					</DialogHeader>
					<textarea
						value={reply}
						onChange={(event) => setReply(event.target.value)}
						placeholder="Reply (optional)"
						aria-label="Reply"
						rows={4}
						autoFocus
						className="min-h-24 w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive">
							Decline
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Accept and Decline for a request, as buttons. */
function IntakeActions({ issue, label }: { issue: Issue; label?: string }) {
	const accept = useAccept();
	const canDecline = useCanDecline(issue.teamId);
	const [declining, setDeclining] = useState(false);
	return (
		<>
			<Button
				variant="outline"
				size="sm"
				aria-label={label && `Accept ${label}`}
				onClick={() => accept(issue)}
			>
				<Check />
				Accept
			</Button>
			<Button
				variant="ghost"
				size="sm"
				aria-label={label && `Decline ${label}`}
				disabled={!canDecline}
				title={canDecline ? undefined : "The team has no canceled status to decline into"}
				onClick={() => setDeclining(true)}
			>
				<Ban />
				Decline
			</Button>
			{declining && <DeclineDialog issue={issue} onClose={() => setDeclining(false)} />}
		</>
	);
}

/** Says an issue is a request in its team's intake, with a way to accept or decline it. */
export function IntakeNotice({ issue, team }: { issue: Issue; team: Team }) {
	const { slug } = useWorkspace();
	if (!issue.intake) return null;
	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
		>
			<Inbox className="size-4 shrink-0 text-muted-foreground" />
			<p className="min-w-0 flex-1 text-muted-foreground">
				A request in{" "}
				<Link
					to="/$workspace/team/$teamKey/intake"
					params={{ workspace: slug, teamKey: team.key }}
					className="underline-offset-2 hover:underline"
				>
					{team.name}'s intake
				</Link>
				. Lists and boards leave it out until someone accepts it.
			</p>
			<div className="flex gap-2">
				<IntakeActions issue={issue} />
			</div>
		</div>
	);
}

/** A team's requests, the oldest first, each with a way to accept or decline it. */
export function TeamIntake({ team }: { team: Team }) {
	const { slug } = useWorkspace();
	const issues = useIntakeIssues(team.id);
	const statuses = useStatuses();
	const members = useMembersById();
	const actions = useWorkspaceActions();
	const admin = isAdmin(useMyRole());
	const [sharing, setSharing] = useState(false);

	// The shortcut and the palette file requests here, as the button does.
	const { setPageDefaults } = actions;
	useEffect(() => {
		setPageDefaults({ teamId: team.id, intake: true });
		return () => setPageDefaults(null);
	}, [setPageDefaults, team.id]);

	const fileRequest = () => actions.createIssue({ teamId: team.id, intake: true });

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<Link
					to="/$workspace/team/$teamKey"
					params={{ workspace: slug, teamKey: team.key }}
					className="truncate text-sm text-muted-foreground hover:text-foreground"
				>
					{team.name}
				</Link>
				<span className="text-sm text-muted-foreground">/</span>
				<h1 className="text-sm font-medium">Intake</h1>
				<span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>
				<div className="ml-auto" />
				{admin && (
					<Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
						<Link2 />
						<span className="hidden sm:inline">
							{team.intakeFormKey === null ? "Request form" : "Form is on"}
						</span>
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={fileRequest}>
					<Plus />
					<span className="hidden sm:inline">New request</span>
				</Button>
			</header>
			{issues.length === 0 ? (
				<Notice
					title="No requests waiting"
					action={
						<Button variant="outline" onClick={fileRequest}>
							New request
						</Button>
					}
				>
					Requests filed here, through the team's request form, or by agents over MCP, wait for
					someone to accept them into the team's workflow or decline them.
				</Notice>
			) : (
				<ul aria-label={`${team.name} intake`} className="divide-y">
					{issues.map((issue) => {
						const key = issueKey(team, issue);
						const creator = actorName(issue.creatorId, members);
						return (
							<li
								key={issue.id}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:px-4"
							>
								<StatusIcon status={statusOf(statuses, issue)} />
								<Link
									to="/$workspace/issue/$issueKey"
									params={{ workspace: slug, issueKey: key }}
									className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
								>
									<span className="shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
									<span className="truncate">{issue.title}</span>
								</Link>
								<span
									className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
									title={formatDateTime(issue.createdAt)}
								>
									{creator},{formatRelative(issue.createdAt)}
								</span>
								<div className="flex shrink-0 gap-1">
									<IntakeActions issue={issue} label={key} />
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{sharing && <RequestFormDialog team={team} onClose={() => setSharing(false)} />}
		</div>
	);
}
