import type {
	IssuePriority,
	IssueTemplate,
	Label,
	Member,
	TemplateRepeat,
} from "@gateweave/track-protocol";

// Issue templates in the app: their order, what using one puts in a new issue, and their
// schedules.

/** "Every week" or "Every 3 months": how often a schedule makes an issue. */
export function repeatLabel(repeat: Pick<TemplateRepeat, "every" | "unit">): string {
	return repeat.every === 1 ? `Every ${repeat.unit}` : `Every ${repeat.every} ${repeat.unit}s`;
}

/** Whether two schedules are the same, so that saving a template sends one only when it changed. */
export function sameRepeat(a: TemplateRepeat | null, b: TemplateRepeat | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.every === b.every &&
		a.unit === b.unit &&
		a.startsOn === b.startsOn &&
		a.timeZone === b.timeZone
	);
}

/** By name, as people look for them. */
export function compareTemplates(a: IssueTemplate, b: IssueTemplate): number {
	return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** What a new issue holds while it is being written, which a template fills in. */
export interface IssueDraft {
	title: string;
	description: string;
	priority: IssuePriority;
	assigneeId: string | null;
	labelIds: string[];
}

/**
 * The draft with the template applied. The template's fields replace what is there, except that
 * an empty title or description leaves what was typed. A label deleted since, or an assignee who
 * left, is left out, as the issue could not have them.
 */
export function applyTemplate(
	draft: IssueDraft,
	template: IssueTemplate,
	labels: ReadonlyMap<string, Label>,
	members: ReadonlyMap<string, Member>,
): IssueDraft {
	const assignee = template.assigneeId ? members.get(template.assigneeId) : undefined;
	return {
		title: template.title.trim() ? template.title : draft.title,
		description: template.description?.trim() ? template.description : draft.description,
		priority: template.priority,
		assigneeId: assignee && assignee.removedAt === null ? assignee.id : null,
		labelIds: template.labelIds.filter((id) => labels.has(id)),
	};
}
