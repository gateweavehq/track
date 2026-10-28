import type { ActivityChange } from "@gateweave/track-protocol";
import { eq, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { type Db, toActivity } from "./state";

/** Changes by one person to one field within this time of each other share one entry. */
export const ACTIVITY_MERGE_WINDOW_MS = 5 * 60 * 1000;

export type MergeDecision =
	/** Start a new entry. */
	| { kind: "append" }
	/** The latest entry already says it. */
	| { kind: "skip" }
	/** Rewrite the latest entry to end at the new value. */
	| { kind: "replace"; change: ActivityChange }
	/** The change undoes the latest entry, so drop it. */
	| { kind: "remove" };

const append: MergeDecision = { kind: "append" };

interface LatestEntry {
	actorId: string;
	change: ActivityChange;
	updatedAt: number;
}

interface IssueOrigin {
	creatorId: string;
	createdAt: number;
}

/**
 * Decides how a change joins an issue's history, given its latest entry. Saving as you type,
 * clicking through statuses or toggling a label then reads as one change, and a change that is
 * put back leaves no trace. Edits to the title and description right after creating an issue
 * are part of writing it, so they are not recorded at all.
 */
export function mergeActivity(
	latest: LatestEntry | undefined,
	issue: IssueOrigin,
	actorId: string,
	change: ActivityChange,
	now: number,
): MergeDecision {
	if (!latest) {
		const drafting =
			actorId === issue.creatorId &&
			now - issue.createdAt <= ACTIVITY_MERGE_WINDOW_MS &&
			(change.type === "title" || change.type === "description");
		return drafting ? { kind: "skip" } : { kind: "append" };
	}
	if (latest.actorId !== actorId || now - latest.updatedAt > ACTIVITY_MERGE_WINDOW_MS) {
		return { kind: "append" };
	}

	const previous = latest.change;
	switch (change.type) {
		case "description":
			return previous.type === "description" ? { kind: "skip" } : { kind: "append" };
		case "label":
			if (previous.type !== "label" || previous.labelId !== change.labelId)
				return { kind: "append" };
			return previous.added === change.added ? { kind: "skip" } : { kind: "remove" };
		case "title":
			return previous.type === "title" ? retarget({ ...change, from: previous.from }) : append;
		case "status":
			return previous.type === "status" ? retarget({ ...change, from: previous.from }) : append;
		case "priority":
			return previous.type === "priority" ? retarget({ ...change, from: previous.from }) : append;
		case "assignee":
			return previous.type === "assignee" ? retarget({ ...change, from: previous.from }) : append;
	}
}

function retarget(change: Extract<ActivityChange, { from: unknown }>): MergeDecision {
	return change.from === change.to ? { kind: "remove" } : { kind: "replace", change };
}

/** Adds a change to an issue's history. Runs inside the mutation's transaction. */
export function recordActivity(
	db: Db,
	changes: ChangeSet,
	issue: schema.IssueRow,
	actorId: string,
	change: ActivityChange,
): void {
	const latest = db
		.select()
		.from(schema.activities)
		.where(eq(schema.activities.issueId, issue.id))
		.orderBy(sql`rowid desc`)
		.limit(1)
		.get();

	const decision = mergeActivity(latest, issue, actorId, change, changes.now);
	if (decision.kind === "skip") return;

	if (decision.kind === "append" || !latest) {
		const row: schema.ActivityRow = {
			id: crypto.randomUUID(),
			issueId: issue.id,
			actorId,
			change,
			createdAt: changes.now,
			updatedAt: changes.now,
		};
		db.insert(schema.activities).values(row).run();
		changes.put("activity", toActivity(row));
	} else if (decision.kind === "replace") {
		const row = db
			.update(schema.activities)
			.set({ change: decision.change, updatedAt: changes.now })
			.where(eq(schema.activities.id, latest.id))
			.returning()
			.get();
		if (row) changes.put("activity", toActivity(row));
	} else {
		db.delete(schema.activities).where(eq(schema.activities.id, latest.id)).run();
		changes.delete("activity", latest.id);
	}
}
