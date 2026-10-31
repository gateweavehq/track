import { addDays, atHour, CLOSED_STATUSES, dayIn } from "@gateweave/track-protocol";
import { and, eq, gte, isNotNull, isNull, notInArray } from "drizzle-orm";
import * as schema from "./db/schema";
import { remindAssignees } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import type { Db } from "./state";
import type { ChangeEvent } from "./webhooks";

/**
 * Due-date reminders. On the day an open issue is due, from {@link REMINDER_HOUR} in its team's
 * time zone (the one its cycles follow, or UTC), Track tells its assignee. An issue reminds once
 * per due date: moving the date reminds again on the new one, and a day that passed without a
 * reminder, as when the date was set after it, reminds nobody. The alarm plans the next reminder
 * as it plans cycle boundaries.
 */

/** The hour, in the team's time zone, at which issues due that day remind their assignees. */
export const REMINDER_HOUR = 9;

interface Reminder {
	issueId: string;
	memberId: string;
	dueOn: string;
	/** When it is due: the reminder hour on the due date. */
	at: number;
	/** The day it is in the team's time zone. */
	today: string;
}

/** Sends the reminders that are due, from the alarm. Track is the actor. */
export function remindDue(db: Db, now: number): WriteResult {
	const changes = new ChangeSet(db, null, now);
	const due = pending(db, now).filter(({ dueOn, today, at }) => dueOn === today && at <= now);
	for (const { issueId, dueOn } of due) {
		db.insert(schema.dueReminders)
			.values({ issueId, dueOn, sentAt: now })
			.onConflictDoUpdate({ target: schema.dueReminders.issueId, set: { dueOn, sentAt: now } })
			.run();
	}
	if (due.length > 0) remindAssignees(db, changes, due);
	return changes.result();
}

/** When the next reminder is due, if any is waiting. One that is overdue is due now. */
export function nextReminderAt(db: Db, now: number): number | null {
	let next: number | null = null;
	for (const { at } of pending(db, now)) {
		if (next === null || at < next) next = at;
	}
	return next;
}

/** Whether a write may have made a reminder due sooner, which the alarm then plans for. */
export function movesReminders(events: readonly ChangeEvent[]): boolean {
	return events.some((event) => {
		if (event.type === "issue.created") return event.issue.dueDate !== null;
		if (event.type !== "issue.updated") return false;
		const { issue, previous } = event;
		return (
			issue.dueDate !== null &&
			(issue.dueDate !== previous.dueDate ||
				issue.assigneeId !== previous.assigneeId ||
				issue.status !== previous.status)
		);
	});
}

/** Reminders not yet sent, for open, assigned issues due today or later. */
function pending(db: Db, now: number): Reminder[] {
	// No time zone is a day or more away from UTC, so an earlier due date is over everywhere.
	const earliest = addDays(dayIn("UTC", now), -1);
	const rows = db
		.select({
			issueId: schema.issues.id,
			memberId: schema.issues.assigneeId,
			dueOn: schema.issues.dueDate,
			cycles: schema.teams.cycles,
			reminded: schema.dueReminders.dueOn,
		})
		.from(schema.issues)
		.innerJoin(schema.teams, eq(schema.teams.id, schema.issues.teamId))
		.leftJoin(schema.dueReminders, eq(schema.dueReminders.issueId, schema.issues.id))
		.where(
			and(
				gte(schema.issues.dueDate, earliest),
				isNotNull(schema.issues.assigneeId),
				isNull(schema.issues.deletedAt),
				notInArray(schema.issues.status, [...CLOSED_STATUSES]),
			),
		)
		.all();
	const reminders: Reminder[] = [];
	for (const { issueId, memberId, dueOn, cycles, reminded } of rows) {
		if (memberId === null || dueOn === null || reminded === dueOn) continue;
		const zone = cycles?.timeZone ?? "UTC";
		const today = dayIn(zone, now);
		if (dueOn < today) continue;
		reminders.push({ issueId, memberId, dueOn, at: atHour(zone, dueOn, REMINDER_HOUR), today });
	}
	return reminders;
}
