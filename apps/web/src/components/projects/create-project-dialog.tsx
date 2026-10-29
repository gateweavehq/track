import { mutationSchema, type ProjectStatus } from "@gateweave/track-protocol";
import { uuidv7 } from "@gateweave/track-sync-client";
import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LeadPicker, ProjectStatusPicker } from "#/components/issues/pickers";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { useWorkspace } from "#/components/workspace/context";
import { useMembersById } from "#/lib/queries";
import { PROJECT_STATUS_META, ProjectStatusIcon } from "./meta";

export function CreateProjectDialog({ onClose }: { onClose: () => void }) {
	const client = useSyncClient();
	const navigate = useNavigate();
	const { slug } = useWorkspace();
	const members = useMembersById();
	const [name, setName] = useState("");
	const [status, setStatus] = useState<ProjectStatus>("planned");
	const [leadId, setLeadId] = useState<string | null>(null);
	const [targetDate, setTargetDate] = useState("");
	const [error, setError] = useState<string | null>(null);
	const lead = leadId ? members.get(leadId) : undefined;

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const id = uuidv7();
		const mutation = {
			name: "project.create" as const,
			args: { id, name, status, leadId, targetDate: targetDate || null },
		};
		const parsed = mutationSchema.safeParse(mutation);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Check the name and the date");
			return;
		}
		// The server has the last word; a refusal is reported by the client's onReject.
		void client.mutate(mutation);
		onClose();
		void navigate({
			to: "/$workspace/project/$projectId",
			params: { workspace: slug, projectId: id },
		});
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>New project</DialogTitle>
					<DialogDescription>
						A project groups issues from any team toward one goal.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="project-name">Name</Label>
						<Input
							id="project-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Public launch"
							maxLength={64}
							autoFocus
							required
						/>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<ProjectStatusPicker value={status} onChange={setStatus}>
							<Button type="button" variant="outline" size="sm" className="h-8 px-2">
								<ProjectStatusIcon status={status} />
								{PROJECT_STATUS_META[status].label}
							</Button>
						</ProjectStatusPicker>
						<LeadPicker value={leadId} onChange={setLeadId}>
							<Button type="button" variant="outline" size="sm" className="h-8 px-2">
								<MemberAvatar member={lead} className="size-4" />
								{lead?.name ?? "Lead"}
							</Button>
						</LeadPicker>
						<div className="flex items-center gap-1">
							<Input
								type="date"
								value={targetDate}
								onChange={(event) => setTargetDate(event.target.value)}
								aria-label="Target date"
								className="h-8 w-40"
							/>
							{targetDate && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label="Clear the target date"
									onClick={() => setTargetDate("")}
								>
									<X />
								</Button>
							)}
						</div>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" disabled={!name.trim()}>
						Create project
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}
