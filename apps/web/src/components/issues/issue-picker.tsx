import type { Issue } from "@gateweave/track-protocol";
import { Check, ListTree } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { issueKey, matchesQuery } from "#/lib/issues";
import { useIssuesById, useTeamsById } from "#/lib/queries";
import { StatusIcon } from "./meta";

/** Workspaces can hold thousands of issues, so the menu lists the best matches only. */
const MAX_SHOWN = 50;

/**
 * Picks an issue to be another's parent, by key or title, or none. The issue itself and its
 * sub-issues, at any depth, are not offered: the server would refuse the loop.
 */
export function ParentPicker({
	issue,
	value,
	onChange,
	children,
	open,
	onOpenChange,
}: {
	issue: Issue;
	value: string | null;
	onChange: (parentId: string | null) => void;
	/** The trigger. Must be a single element that accepts a ref, such as a button. */
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent className="w-80 p-0" align="start">
				{open && (
					<ParentOptions
						issue={issue}
						value={value}
						onSelect={(parentId) => {
							onOpenChange(false);
							if (parentId !== value) onChange(parentId);
						}}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

function ParentOptions({
	issue,
	value,
	onSelect,
}: {
	issue: Issue;
	value: string | null;
	onSelect: (parentId: string | null) => void;
}) {
	const issues = useIssuesById();
	const teams = useTeamsById();
	const [query, setQuery] = useState("");
	const candidates = useMemo(() => {
		const excluded = withSubIssues(issues, issue.id);
		return [...issues.values()]
			.filter((other) => !excluded.has(other.id))
			.map((other) => ({ issue: other, key: issueKey(teams.get(other.teamId), other) }))
			.sort((a, b) => b.issue.updatedAt - a.issue.updatedAt);
	}, [issues, teams, issue.id]);
	const shown = useMemo(
		() =>
			candidates
				.filter((candidate) => matchesQuery(query, candidate.key, candidate.issue.title))
				.slice(0, MAX_SHOWN),
		[candidates, query],
	);

	return (
		<Command shouldFilter={false} loop vimBindings={false}>
			<CommandInput value={query} onValueChange={setQuery} placeholder="Set parent issue…" />
			<CommandList>
				<CommandEmpty>No matching issues</CommandEmpty>
				<CommandGroup>
					{!query && (
						<CommandItem value="none" onSelect={() => onSelect(null)}>
							<ListTree className="size-4 text-muted-foreground" />
							<span>No parent</span>
							{value === null && <Check className="ml-auto size-4" />}
						</CommandItem>
					)}
					{shown.map(({ issue: candidate, key }) => (
						<CommandItem
							key={candidate.id}
							value={candidate.id}
							onSelect={() => onSelect(candidate.id)}
						>
							<StatusIcon status={candidate.status} />
							<span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
							<span className="truncate">{candidate.title}</span>
							{candidate.id === value && <Check className="ml-auto size-4 shrink-0" />}
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</Command>
	);
}

/** The issue and every issue under it. */
function withSubIssues(issues: ReadonlyMap<string, Issue>, issueId: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const issue of issues.values()) {
		if (issue.parentId === null) continue;
		const siblings = children.get(issue.parentId);
		if (siblings) siblings.push(issue.id);
		else children.set(issue.parentId, [issue.id]);
	}
	const found = new Set([issueId]);
	const queue = [issueId];
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		for (const child of children.get(next) ?? []) {
			if (found.has(child)) continue;
			found.add(child);
			queue.push(child);
		}
	}
	return found;
}
