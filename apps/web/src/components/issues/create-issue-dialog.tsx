import type { IssuePriority, IssueStatus } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog";
import { Kbd } from "#/components/ui/kbd";
import { type IssueDefaults, useWorkspace } from "#/components/workspace/context";
import { MOD_LABEL } from "#/lib/hotkeys";
import { issueKey, sortOrderAfter } from "#/lib/issues";
import { send } from "#/lib/mutations";
import { useMembersById, useTeams } from "#/lib/queries";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";
import { AssigneePicker, PriorityPicker, StatusPicker, TeamPicker } from "./pickers";

export function CreateIssueDialog({
	defaults,
	onClose,
}: {
	defaults: IssueDefaults;
	onClose: () => void;
}) {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const teams = useTeams();
	const members = useMembersById();
	const [teamId, setTeamId] = useState(defaults.teamId ?? teams[0]?.id ?? "");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [status, setStatus] = useState<IssueStatus>(defaults.status ?? "backlog");
	const [priority, setPriority] = useState<IssuePriority>(0);
	const [assigneeId, setAssigneeId] = useState<string | null>(defaults.assigneeId ?? null);
	const team = teams.find((t) => t.id === teamId) ?? teams[0];

	function submit() {
		if (!team || !title.trim()) return;
		const id = uuidv7();
		const sent = send(client, {
			name: "issue.create",
			args: {
				id,
				teamId: team.id,
				title,
				description: description.trim() ? description : null,
				status,
				priority,
				assigneeId,
				sortOrder: sortOrderAfter(client.getState().issues.values()),
			},
		});
		if (!sent) return;
		onClose();
		const created = client.getState().issues.get(id);
		toast.success(created ? `Created ${issueKey(team, created)}` : "Issue created", {
			description: title.trim(),
			action: {
				label: "Open",
				// The server may renumber the issue, so look its key up when the user asks.
				onClick: () => {
					const state = client.getState();
					const issue = state.issues.get(id);
					if (!issue) return;
					void navigate({
						to: "/$workspace/issue/$issueKey",
						params: { workspace: slug, issueKey: issueKey(state.teams.get(issue.teamId), issue) },
					});
				},
			},
		});
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		submit();
	}

	function onKeyDown(event: KeyboardEvent) {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="top-[20%] max-w-2xl translate-y-0 gap-0 p-0">
				<form onSubmit={onSubmit} onKeyDown={onKeyDown}>
					<div className="flex items-center gap-1.5 px-4 pt-4 text-sm">
						<TeamPicker teams={teams} value={team?.id ?? ""} onChange={setTeamId}>
							<Button type="button" variant="outline" size="sm" className="h-7 px-2 font-mono">
								{team?.key ?? "Team"}
							</Button>
						</TeamPicker>
						<ChevronRight className="size-4 text-muted-foreground" />
						<DialogTitle className="text-sm font-normal">New issue</DialogTitle>
						<DialogDescription className="sr-only">
							Give the issue a title, then press Enter to create it.
						</DialogDescription>
					</div>
					<div className="space-y-2 px-4 py-3">
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Issue title"
							aria-label="Title"
							maxLength={512}
							autoFocus
							className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground"
						/>
						<textarea
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="Add a description…"
							aria-label="Description"
							rows={4}
							className="field-sizing-content max-h-80 min-h-24 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						/>
					</div>
					<div className="flex flex-wrap gap-2 px-4 pb-3">
						<StatusPicker value={status} onChange={setStatus}>
							<Button type="button" variant="outline" size="sm" className="h-7 px-2">
								<StatusIcon status={status} />
								{STATUS_META[status].label}
							</Button>
						</StatusPicker>
						<PriorityPicker value={priority} onChange={setPriority}>
							<Button type="button" variant="outline" size="sm" className="h-7 px-2">
								<PriorityIcon priority={priority} />
								{priority === 0 ? "Priority" : PRIORITY_META[priority].label}
							</Button>
						</PriorityPicker>
						<AssigneePicker value={assigneeId} onChange={setAssigneeId}>
							<Button type="button" variant="outline" size="sm" className="h-7 px-2">
								<MemberAvatar
									member={assigneeId ? members.get(assigneeId) : undefined}
									className="size-4"
								/>
								{assigneeId ? (members.get(assigneeId)?.name ?? "Unknown") : "Assignee"}
							</Button>
						</AssigneePicker>
					</div>
					<div className="flex items-center justify-end gap-3 border-t px-4 py-3">
						<span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
							<Kbd>{MOD_LABEL}</Kbd>
							<Kbd>Enter</Kbd>
						</span>
						<Button type="submit" size="sm" disabled={!team || !title.trim()}>
							Create issue
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
