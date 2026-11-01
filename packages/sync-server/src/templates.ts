import {
	addDays,
	dayIn,
	MAX_TEMPLATES_PER_TEAM,
	type MutationArgs,
	nextRepeatDay,
	type TemplateRepeat,
} from "@gateweave/track-protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { MutationRejected } from "./rejected";
import { activeMember, type Db, toTemplate } from "./state";

// Issue templates: a team's starting points for new issues. Any member keeps them, as labels.
// Using one is the client's business: it fills in a new issue, which `issue.create` then checks
// like any other, so a template whose label was deleted or whose assignee left still works.
// A template on a schedule also makes issues on its own, from the alarm (`recurring.ts`).

export function createTemplate(db: Db, changes: ChangeSet, args: MutationArgs<"template.create">) {
	if (findTemplate(db, args.id))
		throw new MutationRejected("invalid", "Template id already exists");
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, args.teamId)).get();
	if (!team) throw new MutationRejected("not_found", "Team not found");
	const count =
		db
			.select({ count: sql<number>`count(*)` })
			.from(schema.templates)
			.where(eq(schema.templates.teamId, team.id))
			.get()?.count ?? 0;
	if (count >= MAX_TEMPLATES_PER_TEAM) {
		throw new MutationRejected(
			"invalid",
			`A team holds at most ${MAX_TEMPLATES_PER_TEAM} templates`,
		);
	}
	assertNameFree(db, team.id, args.name);
	const labelIds = liveLabels(db, args.labelIds);
	assertAssignable(db, args.assigneeId);
	if (args.repeat) assertTitled(args.title);

	const row: schema.TemplateRow = {
		...args,
		labelIds,
		nextOn: args.repeat && nextRepeatOn(args.repeat, null, changes.now),
		repeatedOn: null,
		createdAt: changes.now,
		updatedAt: changes.now,
	};
	db.insert(schema.templates).values(row).run();
	changes.put("template", toTemplate(row));
}

export function updateTemplate(db: Db, changes: ChangeSet, args: MutationArgs<"template.update">) {
	const template = findTemplate(db, args.id);
	if (!template) throw new MutationRejected("not_found", "Template not found");
	const { patch } = args;
	if (patch.name !== undefined) assertNameFree(db, template.teamId, patch.name, template.id);
	if (patch.assigneeId !== undefined) assertAssignable(db, patch.assigneeId);
	const labels = patch.labelIds === undefined ? {} : { labelIds: liveLabels(db, patch.labelIds) };
	const repeat = patch.repeat === undefined ? template.repeat : patch.repeat;
	if (repeat) assertTitled(patch.title ?? template.title);
	// A schedule is planned anew only when it changes, never past the day of the last issue.
	const schedule =
		patch.repeat === undefined
			? {}
			: { nextOn: patch.repeat && nextRepeatOn(patch.repeat, template.repeatedOn, changes.now) };

	const row = db
		.update(schema.templates)
		.set({ ...patch, ...labels, ...schedule, updatedAt: changes.now })
		.where(eq(schema.templates.id, template.id))
		.returning()
		.get();
	if (row) changes.put("template", toTemplate(row));
}

export function deleteTemplate(db: Db, changes: ChangeSet, args: MutationArgs<"template.delete">) {
	const template = findTemplate(db, args.id);
	if (!template) throw new MutationRejected("not_found", "Template not found");
	db.delete(schema.templates).where(eq(schema.templates.id, template.id)).run();
	changes.delete("template", template.id);
}

/** Takes a deleted label off the templates that have it, as it is taken off issues. */
export function dropTemplateLabel(db: Db, changes: ChangeSet, labelId: string): void {
	const labeled = db
		.select()
		.from(schema.templates)
		.where(
			sql`exists (select 1 from json_each(${schema.templates.labelIds}) where value = ${labelId})`,
		)
		.all();
	for (const template of labeled) {
		const row = db
			.update(schema.templates)
			.set({
				labelIds: template.labelIds.filter((id) => id !== labelId),
				updatedAt: changes.now,
			})
			.where(eq(schema.templates.id, template.id))
			.returning()
			.get();
		if (row) changes.put("template", toTemplate(row));
	}
}

/**
 * The day a schedule makes its next issue: today or later, in its time zone, and after
 * `repeatedOn`, the day it last made one.
 */
export function nextRepeatOn(
	repeat: TemplateRepeat,
	repeatedOn: string | null,
	now: number,
): string {
	const today = dayIn(repeat.timeZone, now);
	const from = repeatedOn !== null && repeatedOn >= today ? addDays(repeatedOn, 1) : today;
	return nextRepeatDay(repeat, from);
}

/** A template that makes issues on its own must give them a title. */
function assertTitled(title: string) {
	if (title.trim() === "") {
		throw new MutationRejected("invalid", "A template that repeats needs a title");
	}
}

function findTemplate(db: Db, id: string) {
	return db.select().from(schema.templates).where(eq(schema.templates.id, id)).get();
}

/** Compared in JavaScript, because SQLite's lower() only folds ASCII. */
function assertNameFree(db: Db, teamId: string, name: string, exceptId?: string) {
	const folded = name.toLowerCase();
	const taken = db
		.select({ id: schema.templates.id, name: schema.templates.name })
		.from(schema.templates)
		.where(eq(schema.templates.teamId, teamId))
		.all()
		.some((template) => template.id !== exceptId && template.name.toLowerCase() === folded);
	if (taken) {
		throw new MutationRejected("conflict", `The team already has a template named "${name}"`);
	}
}

/** The labels, once each, all of which must be live. */
function liveLabels(db: Db, labelIds: readonly string[]): string[] {
	const unique = [...new Set(labelIds)];
	for (const labelId of unique) {
		const label = db
			.select({ id: schema.labels.id })
			.from(schema.labels)
			.where(and(eq(schema.labels.id, labelId), isNull(schema.labels.deletedAt)))
			.get();
		if (!label) throw new MutationRejected("not_found", "Label not found");
	}
	return unique;
}

function assertAssignable(db: Db, assigneeId: string | null) {
	if (assigneeId !== null && !activeMember(db, assigneeId)) {
		throw new MutationRejected("invalid", "Assignee is not a workspace member");
	}
}
