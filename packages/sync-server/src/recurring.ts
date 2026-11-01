import {
	dayIn,
	firstStatus,
	liveStatuses,
	SYSTEM_ACTOR_ID,
	startOfDay,
} from "@gateweave/track-protocol";
import { and, asc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import * as schema from "./db/schema";
import { notify } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import { indexIssue } from "./search";
import { activeMember, type Db, toIssue, toTemplate } from "./state";
import { teamStatuses } from "./statuses";
import { nextRepeatOn } from "./templates";
import { queueDeliveries } from "./webhooks";

// Recurring issues: a template on a schedule makes an issue at the start of each day the schedule
// falls on, in its time zone. Track is the creator, so the assignee hears of it as of any issue
// assigned to them, and webhooks get `issue.created`. A workspace whose alarm was held up past
// several of those days makes one issue, not one for each, and plans the next from today.

/** The most issues one run makes, so a workspace with many schedules due works in short writes. */
export const RECURRING_BATCH = 50;

/** When the next scheduled issue is due: null when no template repeats. */
export function nextRecurringAt(db: Db): number | null {
	let next: number | null = null;
	for (const template of scheduled(db)) {
		if (template.repeat === null || template.nextOn === null) continue;
		const at = startOfDay(template.repeat.timeZone, template.nextOn);
		if (next === null || at < next) next = at;
	}
	return next;
}

/** Makes the issues that are due, from the alarm, and plans each template's next. */
export function runRecurring(db: Db, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const due = scheduled(db)
		.flatMap((template) => {
			const { repeat, nextOn } = template;
			if (repeat === null || nextOn === null) return [];
			const at = startOfDay(repeat.timeZone, nextOn);
			return at <= now ? [{ template, repeat, at }] : [];
		})
		.sort((a, b) => a.at - b.at)
		.slice(0, RECURRING_BATCH);

	for (const { template, repeat } of due) {
		createIssue(db, changes, template);
		const today = dayIn(repeat.timeZone, now);
		const row = db
			.update(schema.templates)
			.set({ repeatedOn: today, nextOn: nextRepeatOn(repeat, today, now) })
			.where(eq(schema.templates.id, template.id))
			.returning()
			.get();
		if (row) changes.put("template", toTemplate(row));
	}

	notify(db, changes, SYSTEM_ACTOR_ID, false);
	const result = changes.result();
	const queued = queueDeliveries(db, null, changes.events, result.version, now);
	return { ...result, queued };
}

function scheduled(db: Db): schema.TemplateRow[] {
	return db
		.select()
		.from(schema.templates)
		.where(isNotNull(schema.templates.nextOn))
		.orderBy(asc(schema.templates.id))
		.all();
}

/**
 * The template's issue, as \`issue.create\` would make it from the same fields: in the team's first
 * not-started status, so it is ready to pick up, after every other issue. Labels deleted since
 * and an assignee who has left are left out.
 */
function createIssue(db: Db, changes: ChangeSet, template: schema.TemplateRow): void {
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, template.teamId)).get();
	if (!team) return;
	const statuses = liveStatuses(teamStatuses(db, team.id));
	const status = statuses.find((each) => each.category === "unstarted") ?? firstStatus(statuses);
	if (!status) return;
	const labelIds =
		template.labelIds.length === 0
			? []
			: db
					.select({ id: schema.labels.id })
					.from(schema.labels)
					.where(and(inArray(schema.labels.id, template.labelIds), isNull(schema.labels.deletedAt)))
					.all()
					.map((label) => label.id);
	const assigneeId =
		template.assigneeId !== null && activeMember(db, template.assigneeId)
			? template.assigneeId
			: null;

	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();
	const row: schema.IssueRow = {
		id: crypto.randomUUID(),
		teamId: team.id,
		number,
		title: template.title.trim(),
		description: template.description,
		status: status.key,
		priority: template.priority,
		assigneeId,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: template.labelIds.filter((id) => labelIds.includes(id)),
		sortOrder: sortOrderAfterAll(db),
		creatorId: SYSTEM_ACTOR_ID,
		version: changes.nextVersion,
		fieldStamps: {},
		createdAt: changes.now,
		updatedAt: changes.now,
		archivedAt: null,
		deletedAt: null,
	};
	db.insert(schema.issues).values(row).run();
	indexIssue(db, row.id);
	changes.put("issue", toIssue(row));
	changes.events.push({ type: "issue.created", issue: row });
}

/** A sort order after every issue's, as the app gives an issue it creates. */
function sortOrderAfterAll(db: Db): string {
	const last = db
		.select({ last: max(schema.issues.sortOrder) })
		.from(schema.issues)
		.get()?.last;
	try {
		return generateKeyBetween(last ?? null, null);
	} catch {
		// An imported sort order the library cannot read must not stop the schedule.
		return generateKeyBetween(null, null);
	}
}
