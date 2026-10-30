import {
	CLOSED_STATUSES,
	type Issue,
	type IssueRelation,
	type RelationKind,
	relationFrom,
} from "@gateweave/track-protocol";
import { Ban, Copy, Link2, type LucideIcon, OctagonAlert } from "lucide-react";

export const RELATION_META: Record<
	RelationKind,
	{
		/** Heading of the group on the issue page. */
		label: string;
		icon: LucideIcon;
		/** The choice in the menu that adds one. */
		pick: string;
		/** Placeholder of the issue search that follows. */
		find: string;
	}
> = {
	blocked_by: {
		label: "Blocked by",
		icon: Ban,
		pick: "Blocked by…",
		find: "Find the issue that blocks it…",
	},
	blocks: {
		label: "Blocks",
		icon: OctagonAlert,
		pick: "Blocks…",
		find: "Find the issue it blocks…",
	},
	duplicate_of: {
		label: "Duplicate of",
		icon: Copy,
		pick: "Duplicate of…",
		find: "Find the issue it duplicates…",
	},
	duplicated_by: {
		label: "Duplicated by",
		icon: Copy,
		pick: "Duplicated by…",
		find: "Find its duplicate…",
	},
	related: { label: "Related", icon: Link2, pick: "Related to…", find: "Find a related issue…" },
};

/** The order of the groups on the issue page: what holds the issue up comes first. */
const RELATION_ORDER: readonly RelationKind[] = [
	"blocked_by",
	"blocks",
	"duplicate_of",
	"duplicated_by",
	"related",
];

/** What a person adds from an issue. "Duplicated by" is added as "Duplicate of" on the other one. */
export const ADDABLE_RELATIONS: readonly RelationKind[] = [
	"blocked_by",
	"blocks",
	"duplicate_of",
	"related",
];

export interface RelatedIssue {
	relation: IssueRelation;
	issue: Issue;
}

/**
 * An issue's relations grouped by what they are from its side, with the issue at the other end,
 * in page order. A relation whose other issue is not in the copy yet is left out.
 */
export function groupRelations(
	relations: readonly IssueRelation[],
	issueId: string,
	issues: ReadonlyMap<string, Issue>,
): { kind: RelationKind; items: RelatedIssue[] }[] {
	const groups = new Map<RelationKind, RelatedIssue[]>();
	for (const relation of relations) {
		const { kind, otherId } = relationFrom(relation, issueId);
		const issue = issues.get(otherId);
		if (!issue) continue;
		const group = groups.get(kind);
		if (group) group.push({ relation, issue });
		else groups.set(kind, [{ relation, issue }]);
	}
	return RELATION_ORDER.flatMap((kind) => {
		const items = groups.get(kind);
		return items ? [{ kind, items }] : [];
	});
}

const isOpen = (issue: Issue | undefined) =>
	issue !== undefined && !CLOSED_STATUSES.includes(issue.status);

/** Open issues that an open issue blocks. A closed blocker no longer holds anything up. */
export function blockedIssueIds(
	relations: Iterable<IssueRelation>,
	issues: ReadonlyMap<string, Issue>,
): Set<string> {
	const blocked = new Set<string>();
	for (const relation of relations) {
		if (relation.type !== "blocks") continue;
		if (isOpen(issues.get(relation.issueId)) && isOpen(issues.get(relation.relatedIssueId))) {
			blocked.add(relation.relatedIssueId);
		}
	}
	return blocked;
}
