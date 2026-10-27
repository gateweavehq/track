import type { Issue } from "@tangent/protocol";
import { Plus, Search } from "lucide-react";
import { type ReactNode, useDeferredValue, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { type IssueDefaults, useWorkspaceActions } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { useHotkeys } from "#/lib/hotkeys";
import { issueKey, matchesQuery } from "#/lib/issues";
import { useMembersById, useTeamsById } from "#/lib/queries";
import { IssueList } from "./issue-list";

/** A page of issues: a header with a filter and a create button, then the grouped list. */
export function IssuesPage({
	title,
	badge,
	issues,
	defaults,
	empty,
}: {
	title: string;
	badge?: ReactNode;
	issues: Issue[];
	defaults: IssueDefaults;
	empty: ReactNode;
}) {
	const actions = useWorkspaceActions();
	const teams = useTeamsById();
	const members = useMembersById();
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const filterRef = useRef<HTMLInputElement>(null);

	useHotkeys({ "/": () => filterRef.current?.focus() });

	const filtered = useMemo(() => {
		if (!deferredQuery.trim()) return issues;
		return issues.filter((issue) =>
			matchesQuery(
				deferredQuery,
				issueKey(teams.get(issue.teamId), issue),
				issue.title,
				(issue.assigneeId && members.get(issue.assigneeId)?.name) || "",
			),
		);
	}, [issues, deferredQuery, teams, members]);

	return (
		<div>
			<header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background px-3 sm:px-4">
				<h1 className="truncate text-sm font-medium">{title}</h1>
				{badge}
				<span className="text-sm text-muted-foreground tabular-nums">{issues.length}</span>
				<div className="ml-auto flex items-center gap-2">
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={filterRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									setQuery("");
									event.currentTarget.blur();
								}
							}}
							placeholder="Filter issues"
							aria-label="Filter issues"
							className="h-8 w-32 rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring sm:w-56"
						/>
					</div>
					<Button size="sm" onClick={() => actions.createIssue(defaults)}>
						<Plus />
						<span className="hidden sm:inline">New issue</span>
					</Button>
				</div>
			</header>
			<IssueList
				issues={filtered}
				defaults={defaults}
				empty={
					query.trim() ? (
						<Notice title="No matching issues">Nothing here matches “{query.trim()}”.</Notice>
					) : (
						empty
					)
				}
			/>
		</div>
	);
}
