import {
	AUTOMATION_MONTH_MS,
	isClosedCategory,
	liveStatuses,
	SYSTEM_ACTOR_ID,
} from "@gateweave/track-protocol";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { type Db, toIssue } from "./state";
import { teamStatuses } from "./statuses";
import { queueDeliveries } from "./webhooks";

// Teams' automations: archiving closed issues, and closing issues nobody started, once no one has
// touched them for as many months as the team chose. The alarm runs them about once a day, as
// Track (`SYSTEM_ACTOR_ID`), each change with a history entry and a webhook, like any other.

/** How often the automations run. A month is their unit, so a day late is on time. */
export const AUTOMATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The most issues one run changes, so a large backlog is worked through in short writes. */
export const AUTOMATION_BATCH = 200;
/** When a run left work for the next, which comes this soon. */
const AUTOMATION_RETRY_MS = 60 * 1000;
/** The stamp of a status the automations wrote, so an older offline edit conflicts with it. */
const AUTOMATION_CLIENT_ID = "automation";
const DUE_KEY = "automations_due";

/** The statuses whose issues count as not started, which closing applies to. */
const NOT_STARTED = new Set(["backlog", "unstarted"]);

/**
 * When the automations run next: null when no team has one, so the alarm need not wake for them.
 * A workspace that never ran them, or a team that just turned one on, is due now.
 */
export function nextAutomationsAt(db: Db): number | null {
	const automated = db
		.select({ id: schema.teams.id })
		.from(schema.teams)
		.where(or(isNotNull(schema.teams.archiveAfterMonths), isNotNull(schema.teams.closeAfterMonths)))
		.get();
	if (!automated) return null;
	const due = db.select().from(schema.meta).where(eq(schema.meta.key, DUE_KEY)).get();
	return due ? Number(due.value) : 0;
}

/** Has the automations run at the next alarm, as when a team turns one on. */
export function automationsDueNow(db: Db, now: number): void {
	setDue(db, now);
}

/**
 * Runs every team's automations, when they are due: closes issues nobody started that have sat
 * untouched past the team's wait, then archives closed issues that have. An issue closed by a run
 * was just touched, so it is archived only after the wait, by a later run.
 */
export function runAutomations(db: Db, now: number): WriteResult {
	const due = nextAutomationsAt(db);
	const changes = new ChangeSet(db, null, now);
	if (due === null || due > now) return changes.result();

	let budget = AUTOMATION_BATCH;
	const teams = db
		.select()
		.from(schema.teams)
		.where(or(isNotNull(schema.teams.archiveAfterMonths), isNotNull(schema.teams.closeAfterMonths)))
		.orderBy(asc(schema.teams.key))
		.all();
	for (const team of teams) {
		if (budget > 0 && team.closeAfterMonths !== null) {
			budget -= closeUntouched(db, changes, team.id, team.closeAfterMonths, budget);
		}
		if (budget > 0 && team.archiveAfterMonths !== null) {
			budget -= archiveUntouched(db, changes, team.id, team.archiveAfterMonths, budget);
		}
	}
	// A run that used its whole batch may have left issues; the next one comes soon to see.
	setDue(db, now + (budget === 0 ? AUTOMATION_RETRY_MS : AUTOMATION_INTERVAL_MS));

	const result = changes.result();
	const queued = queueDeliveries(db, null, changes.events, result.version, now);
	return { ...result, queued };
}

/** Closes up to `limit` of the team's untouched issues that are not started; how many it closed. */
function closeUntouched(
	db: Db,
	changes: ChangeSet,
	teamId: string,
	months: number,
	limit: number,
): number {
	const statuses = liveStatuses(teamStatuses(db, teamId));
	// A team with no canceled status has nowhere to close them to.
	const target = statuses.find((status) => status.category === "canceled");
	if (!target) return 0;
	const waiting = statuses
		.filter((status) => NOT_STARTED.has(status.category))
		.map((status) => status.key);
	if (waiting.length === 0) return 0;

	const issues = untouched(db, teamId, months, changes.now, limit, waiting);
	for (const issue of issues) {
		const version = changes.nextVersion;
		const fieldStamps = {
			...issue.fieldStamps,
			status: { version, clientId: AUTOMATION_CLIENT_ID },
		};
		const row = db
			.update(schema.issues)
			.set({ status: target.key, fieldStamps, version, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) continue;
		changes.put("issue", toIssue(row));
		// The team's rule rather than anyone's change to the issue: webhooks hear of it, inboxes not.
		changes.events.push({ type: "issue.updated", issue: row, previous: issue, quiet: true });
		recordActivity(db, changes, issue, SYSTEM_ACTOR_ID, {
			type: "status",
			from: issue.status,
			to: target.key,
		});
	}
	return issues.length;
}

/** Archives up to `limit` of the team's untouched closed issues; how many it archived. */
function archiveUntouched(
	db: Db,
	changes: ChangeSet,
	teamId: string,
	months: number,
	limit: number,
): number {
	const closed = liveStatuses(teamStatuses(db, teamId))
		.filter((status) => isClosedCategory(status.category))
		.map((status) => status.key);
	if (closed.length === 0) return 0;

	const issues = untouched(db, teamId, months, changes.now, limit, closed);
	for (const issue of issues) {
		const row = db
			.update(schema.issues)
			.set({ archivedAt: changes.now, version: changes.nextVersion, updatedAt: changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) continue;
		changes.put("issue", toIssue(row));
		changes.events.push({ type: "issue.updated", issue: row, previous: issue, quiet: true });
		recordActivity(db, changes, issue, SYSTEM_ACTOR_ID, { type: "archived", archived: true });
	}
	return issues.length;
}

/** The team's live, unarchived issues in these statuses that no one touched for the months. */
function untouched(
	db: Db,
	teamId: string,
	months: number,
	now: number,
	limit: number,
	statuses: string[],
): schema.IssueRow[] {
	return db
		.select()
		.from(schema.issues)
		.where(
			and(
				eq(schema.issues.teamId, teamId),
				isNull(schema.issues.deletedAt),
				isNull(schema.issues.archivedAt),
				inArray(schema.issues.status, statuses),
				lt(schema.issues.updatedAt, now - months * AUTOMATION_MONTH_MS),
			),
		)
		.orderBy(asc(schema.issues.updatedAt), asc(schema.issues.id))
		.limit(limit)
		.all();
}

function setDue(db: Db, at: number): void {
	const value = String(at);
	db.insert(schema.meta)
		.values({ key: DUE_KEY, value })
		.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
		.run();
}
