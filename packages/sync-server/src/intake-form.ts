import { INTAKE_FORM_ACTOR_ID, type WebhookActor } from "@gateweave/track-protocol";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { indexIssue } from "./search";
import { type Db, toIssue } from "./state";
import { defaultStatusKey } from "./statuses";
import { queueDeliveries } from "./webhooks";

/** How webhooks name whoever filed through a request form: not a member, so the form itself. */
export const INTAKE_FORM_WEBHOOK_ACTOR: WebhookActor = {
	id: INTAKE_FORM_ACTOR_ID,
	name: "Request form",
	type: "system",
};

const formKey = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * A request as the gateway passes it on, once the person filling in the form has passed
 * Turnstile. The gateway also picks where it goes in the manual order, as MCP's tools do.
 */
export const intakeRequest = z.object({
	formKey,
	title: z.string().trim().min(1).max(512),
	description: z.string().max(100_000).nullable(),
	sortOrder: z.string().min(1).max(64),
});
export type IntakeRequest = z.infer<typeof intakeRequest>;

export interface IntakeForm {
	teamId: string;
	teamName: string;
}

/** The team whose form a key opens, or null for a key no form has, as when the form is off. */
export function findIntakeForm(db: Db, key: string): IntakeForm | null {
	if (!formKey.safeParse(key).success) return null;
	const team = db
		.select({ id: schema.teams.id, name: schema.teams.name })
		.from(schema.teams)
		.where(and(isNotNull(schema.teams.intakeFormKey), eq(schema.teams.intakeFormKey, key)))
		.get();
	return team ? { teamId: team.id, teamName: team.name } : null;
}

/**
 * Files a request into the intake of the team whose form it came through, in the team's first
 * status. The form is its creator, as nobody it came from is a member. It tells nobody in their
 * inbox, so a stranger's text cannot mention people into hearing from it; webhooks hear of it as
 * of any new issue. Null when the form is off. Runs in one transaction.
 */
export function fileRequest(
	db: Db,
	request: IntakeRequest,
	now: number,
): { result: WriteResult; issueId: string } | null {
	const form = findIntakeForm(db, request.formKey);
	if (!form) return null;
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, form.teamId)).get();
	if (!team) return null;

	const changes = new ChangeSet(db, INTAKE_FORM_ACTOR_ID, now);
	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();
	const row: schema.IssueRow = {
		id: crypto.randomUUID(),
		teamId: team.id,
		number,
		title: request.title,
		description: request.description?.trim() ? request.description : null,
		status: defaultStatusKey(db, team.id),
		priority: 0,
		assigneeId: null,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		creatorId: INTAKE_FORM_ACTOR_ID,
		labelIds: [],
		sortOrder: request.sortOrder,
		version: changes.nextVersion,
		fieldStamps: {},
		createdAt: now,
		updatedAt: now,
		archivedAt: null,
		intake: true,
		deletedAt: null,
	};
	db.insert(schema.issues).values(row).run();
	indexIssue(db, row.id);
	changes.put("issue", toIssue(row));
	changes.events.push({ type: "issue.created", issue: row });

	const result = changes.result();
	const queued = queueDeliveries(
		db,
		INTAKE_FORM_WEBHOOK_ACTOR,
		changes.events,
		result.version,
		now,
	);
	return { result: { ...result, queued }, issueId: row.id };
}
