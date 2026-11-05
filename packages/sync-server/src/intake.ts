import {
	INTAKE_EMAIL_ACTOR_ID,
	INTAKE_FORM_ACTOR_ID,
	userText,
	type WebhookActor,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import { notifyOfRequest } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import { recordRequester } from "./requesters";
import { indexIssue } from "./search";
import { type Db, toIssue } from "./state";
import { defaultStatusKey, isClosedStatus } from "./statuses";
import { queueDeliveries } from "./webhooks";

/**
 * The ways in for people who are not members: a team's public request form, and its intake
 * email address. Each has a secret key, which the Durable Object makes when an admin turns it on.
 */
const CHANNELS = {
	form: {
		key: /^[0-9a-f]{32}$/,
		column: schema.teams.intakeFormKey,
		actor: { id: INTAKE_FORM_ACTOR_ID, name: "Request form", type: "system" },
	},
	email: {
		key: /^[a-z2-7]{16}$/,
		column: schema.teams.intakeEmailKey,
		actor: { id: INTAKE_EMAIL_ACTOR_ID, name: "Email", type: "system" },
	},
} satisfies Record<string, { key: RegExp; column: unknown; actor: WebhookActor }>;

export type IntakeChannel = keyof typeof CHANNELS;

/**
 * A request as a gateway passes it on, once it has checked who may send it: Turnstile for the
 * form, a rate limit for email. The gateway also picks where it goes in the manual order, as
 * MCP's tools do.
 */
export const intakeRequest = z.object({
	via: z.enum(["form", "email"]),
	key: z.string().max(64),
	title: userText.trim().min(1).max(512),
	description: userText.max(100_000).nullable(),
	sortOrder: z.string().min(1).max(64),
	/**
	 * Whoever filed it, to tell of the decision on it, if they left an address; with the
	 * workspace's id, which the gateway checked in D1, for the email to name it.
	 */
	requester: z
		.object({ workspaceId: z.string().min(1).max(64), email: z.email().max(254) })
		.nullable()
		.default(null),
});
export type IntakeRequest = z.infer<typeof intakeRequest>;

export interface IntakeTarget {
	teamId: string;
	teamName: string;
}

/** The team a channel's key reaches, or null for a key no team has, as when it is off. */
export function findIntake(db: Db, via: IntakeChannel, key: string): IntakeTarget | null {
	const channel = CHANNELS[via];
	if (!channel.key.test(key)) return null;
	const team = db
		.select({ id: schema.teams.id, name: schema.teams.name })
		.from(schema.teams)
		.where(eq(channel.column, key))
		.get();
	return team ? { teamId: team.id, teamName: team.name } : null;
}

/**
 * Files a request into the intake of the team whose channel it came through, in the team's first
 * status. The channel is its creator, as nobody it came from need be a member. It mentions nobody,
 * so a stranger's text cannot bring people to it: only those who follow the team's intake hear of
 * it, as webhooks do of any new issue. Null when the channel is off. Runs in one transaction.
 */
export function fileRequest(
	db: Db,
	request: IntakeRequest,
	now: number,
): { result: WriteResult; issueId: string } | null {
	const target = findIntake(db, request.via, request.key);
	if (!target) return null;
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, target.teamId)).get();
	if (!team) return null;
	const { actor } = CHANNELS[request.via];
	// A request is never closed, so a team whose first status closes takes none.
	const status = defaultStatusKey(db, team.id);
	if (isClosedStatus(db, team.id, status)) return null;

	const changes = new ChangeSet(db, actor.id, now);
	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();
	const row: schema.IssueRow = {
		id: crypto.randomUUID(),
		teamId: team.id,
		number,
		title: request.title,
		description: request.description?.trim() ? request.description : null,
		status,
		priority: 0,
		assigneeId: null,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		creatorId: actor.id,
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
	if (request.requester) recordRequester(db, row.id, request.requester, now);
	indexIssue(db, row.id);
	changes.put("issue", toIssue(row));
	changes.events.push({ type: "issue.created", issue: row });

	const wake = notifyOfRequest(db, changes, actor.id, row);
	const result = changes.result();
	const queued = queueDeliveries(db, actor, changes.events, result.version, now);
	return { result: { ...result, queued, wake }, issueId: row.id };
}
