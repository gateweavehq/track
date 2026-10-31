import type { Issue, PullRequest, PullRequestState } from "@gateweave/track-protocol";
import {
	GitBranch,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { branchName } from "#/lib/branches";
import { useIssuePullRequests } from "#/lib/queries";
import { cn } from "#/lib/utils";

const STATE_META: Record<PullRequestState, { label: string; icon: LucideIcon; className: string }> =
	{
		draft: { label: "Draft", icon: GitPullRequestDraft, className: "text-muted-foreground" },
		open: { label: "Open", icon: GitPullRequest, className: "text-emerald-500" },
		merged: { label: "Merged", icon: GitMerge, className: "text-violet-500" },
		closed: { label: "Closed", icon: GitPullRequestClosed, className: "text-destructive" },
	};

/**
 * The pull requests on GitHub that mention the issue, from a workspace's GitHub connections.
 * Nothing shows until there is one.
 */
export function PullRequests({ issue }: { issue: Issue }) {
	const pullRequests = useIssuePullRequests(issue.id);
	if (pullRequests.length === 0) return null;
	return (
		<section aria-labelledby="pull-requests-heading" className="space-y-2">
			<h2 id="pull-requests-heading" className="text-sm font-medium">
				Pull requests
			</h2>
			<ul className="rounded-lg border">
				{pullRequests.map((pullRequest) => (
					<PullRequestRow key={pullRequest.id} pullRequest={pullRequest} issueId={issue.id} />
				))}
			</ul>
		</section>
	);
}

function PullRequestRow({ pullRequest, issueId }: { pullRequest: PullRequest; issueId: string }) {
	const { label, icon: Icon, className } = STATE_META[pullRequest.state];
	const fixes = pullRequest.closingIssueIds.includes(issueId);
	return (
		<li className="relative flex h-9 items-center gap-2 border-b px-2 text-sm last:border-b-0 hover:bg-accent/40">
			<Icon role="img" aria-label={label} className={cn("size-4 shrink-0", className)} />
			<span className="shrink-0 font-mono text-xs text-muted-foreground">
				{pullRequest.repository}#{pullRequest.number}
			</span>
			<a
				href={pullRequest.url}
				target="_blank"
				rel="noreferrer"
				className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
			>
				{pullRequest.title}
			</a>
			{fixes && (
				<span
					className="shrink-0 rounded-full border px-1.5 text-xs text-muted-foreground"
					title="Merging it moves this issue to Done"
				>
					Fixes
				</span>
			)}
			{pullRequest.author && (
				<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
					{pullRequest.author}
				</span>
			)}
		</li>
	);
}

/** Copies a branch name for the issue, which links a pull request from that branch to it. */
export function CopyBranchButton({ issueKey, title }: { issueKey: string; title: string }) {
	async function copy() {
		const name = branchName(issueKey, title);
		try {
			await navigator.clipboard.writeText(name);
			toast.success("Branch name copied", { description: name });
		} catch {
			toast.error("Could not copy the branch name");
		}
	}
	return (
		<Button
			variant="ghost"
			size="icon"
			className="size-8"
			aria-label="Copy branch name"
			title="Copy branch name"
			onClick={copy}
		>
			<GitBranch />
		</Button>
	);
}
