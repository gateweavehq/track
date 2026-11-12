import {
	AUDIT_PAGE_SIZE,
	type AuditAction,
	type AuditDetail,
	type AuditEvent,
	type AuditPage,
	type AuditPerson,
	type AuditTarget,
	type Mutation,
	type TeamChange,
	type Webhook,
} from "@gateweave/track-protocol";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Db } from "./state";
import { findLiveStatus } from "./statuses";

/**
 * The workspace's audit log: who changed who belongs to it and how it is set up. See
 * `@gateweave/track-protocol`'s audit.ts for what is recorded. Each event is written in the same
 * transaction as its change, so a change that is refused leaves none.
 */

/** Long enough to look back over a year's changes; no longer, as it names people. */
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export interface AuditRecord {
	actorId: string | null;
	action: AuditAction;
	target: AuditTarget;
	detail?: AuditDetail;
}

export function recordAudit(db: Db, event: AuditRecord, now: number): void {
	db.insert(schema.auditEvents)
		.values({
			at: now,
			actorId: event.actorId,
			action: event.action,
			targetType: event.target.type,
			targetId: event.target.id,
			targetLabel: event.target.label,
			detail: event.detail ?? {},
		})
		.run();
}

/** A page of the log, the newest first, with everyone its events name. */
export function readAuditPage(db: Db, before?: number): AuditPage {
	const rows = db
		.select()
		.from(schema.auditEvents)
		.where(before === undefined ? undefined : lt(schema.auditEvents.id, before))
		.orderBy(desc(schema.auditEvents.id))
		.limit(AUDIT_PAGE_SIZE + 1)
		.all();
	const page = rows.slice(0, AUDIT_PAGE_SIZE);
	const events = page.map(toAuditEvent);
	const last = page.at(-1);
	return {
		events,
		people: peopleIn(db, events),
		next: rows.length > AUDIT_PAGE_SIZE && last ? last.id : null,
	};
}

function toAuditEvent(row: schema.AuditEventRow): AuditEvent {
	return {
		id: row.id,
		at: row.at,
		actorId: row.actorId,
		action: row.action,
		target: { type: row.targetType, id: row.targetId, label: row.targetLabel },
		detail: row.detail,
	};
}

/**
 * Named as the workspace knows them now, so someone who deleted their account is named as such.
 * Matched through `json_each`, since a page can name more members than a query takes parameters.
 */
function peopleIn(db: Db, events: AuditEvent[]): Record<string, AuditPerson> {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.actorId) ids.add(event.actorId);
		if ((event.target.type === "member" || event.target.type === "agent") && event.target.id) {
			ids.add(event.target.id);
		}
		if (typeof event.detail.author === "string") ids.add(event.detail.author);
	}
	const people: Record<string, AuditPerson> = {};
	if (ids.size === 0) return people;
	const rows = db
		.select()
		.from(schema.members)
		.where(
			sql`${schema.members.userId} in (select value from json_each(${JSON.stringify([...ids])}))`,
		)
		.all();
	for (const row of rows) {
		people[row.userId] = { name: row.name, image: row.image, agent: row.role === "agent" };
	}
	return people;
}

/** Drops the events older than a year. Run with the oplog's compaction. */
export function pruneAudit(db: Db, now: number): void {
	db.delete(schema.auditEvents)
		.where(lt(schema.auditEvents.at, now - AUDIT_RETENTION_MS))
		.run();
}

/**
 * Clears an address that someone who deleted their account was invited at. Invitations are kept
 * by address, as the person invited may not have joined; addresses are stored in lower case.
 */
export function forgetInAudit(db: Db, email: string): void {
	if (!email) return;
	db.update(schema.auditEvents)
		.set({ targetLabel: null })
		.where(
			and(
				eq(schema.auditEvents.targetType, "invitation"),
				eq(schema.auditEvents.targetLabel, email.toLowerCase()),
			),
		)
		.run();
}

// Mutations. What the log needs from one is read before it runs, and recorded after it has, by
// comparing: a mutation that changes nothing records nothing.

type Recorder = (now: number) => void;

/**
 * Reads what the log needs about a mutation before it runs, and returns what records it once it
 * has; null for a mutation the log does not follow.
 */
export function auditMutation(db: Db, actorId: string, mutation: Mutation): Recorder | null {
	const record = (now: number, action: AuditAction, target: AuditTarget, detail?: AuditDetail) =>
		recordAudit(db, { actorId, action, target, ...(detail && { detail }) }, now);

	switch (mutation.name) {
		case "team.create": {
			const { id } = mutation.args;
			return (now) => {
				const team = findTeam(db, id);
				if (team) record(now, "team.created", teamTarget(team), { key: team.key });
			};
		}
		case "team.update": {
			const before = findTeam(db, mutation.args.id);
			if (!before) return null;
			return (now) => {
				const after = findTeam(db, before.id);
				if (!after) return;
				for (const change of teamChanges(before, after)) {
					record(now, "team.updated", teamTarget(after), change);
				}
			};
		}
		case "status.create": {
			const { teamId, key } = mutation.args;
			return (now) => {
				const team = findTeam(db, teamId);
				const status = findLiveStatus(db, teamId, key);
				if (team && status) {
					record(now, "status.created", statusTarget(status), { team: team.key });
				}
			};
		}
		case "status.update": {
			const { teamId, key } = mutation.args;
			const before = findLiveStatus(db, teamId, key);
			if (!before) return null;
			return (now) => {
				const team = findTeam(db, teamId);
				const after = findLiveStatus(db, teamId, key);
				if (!team || !after) return;
				for (const change of ["name", "category"] as const) {
					if (before[change] === after[change]) continue;
					record(now, "status.updated", statusTarget(after), {
						team: team.key,
						change,
						from: before[change],
						to: after[change],
					});
				}
			};
		}
		case "status.delete": {
			const { teamId, key, moveTo } = mutation.args;
			const status = findLiveStatus(db, teamId, key);
			const next = findLiveStatus(db, teamId, moveTo);
			const team = findTeam(db, teamId);
			if (!status || !next || !team) return null;
			return (now) =>
				record(now, "status.deleted", statusTarget(status), {
					team: team.key,
					moveTo: next.name,
				});
		}
		case "label.delete": {
			const label = db
				.select()
				.from(schema.labels)
				.where(and(eq(schema.labels.id, mutation.args.id), isNull(schema.labels.deletedAt)))
				.get();
			if (!label) return null;
			return (now) =>
				record(now, "label.deleted", { type: "label", id: label.id, label: label.name });
		}
		case "project.delete": {
			const project = db
				.select()
				.from(schema.projects)
				.where(and(eq(schema.projects.id, mutation.args.id), isNull(schema.projects.deletedAt)))
				.get();
			if (!project) return null;
			return (now) =>
				record(now, "project.deleted", { type: "project", id: project.id, label: project.name });
		}
		case "issue.delete": {
			const key = liveIssueKey(db, mutation.args.id);
			if (!key) return null;
			// The key alone: a title can hold what the issue was deleted for holding.
			return (now) =>
				record(now, "issue.deleted", { type: "issue", id: mutation.args.id, label: key });
		}
		case "comment.delete": {
			const comment = db
				.select()
				.from(schema.comments)
				.where(and(eq(schema.comments.id, mutation.args.id), isNull(schema.comments.deletedAt)))
				.get();
			// Deleting what one wrote oneself is not an admin's doing.
			if (!comment || comment.authorId === actorId) return null;
			const key = liveIssueKey(db, comment.issueId);
			if (!key) return null;
			return (now) =>
				record(
					now,
					"comment.deleted",
					{ type: "comment", id: comment.id, label: key },
					{ author: comment.authorId },
				);
		}
		case "agent.update": {
			const before = findMember(db, mutation.args.id);
			if (before?.role !== "agent") return null;
			return (now) => {
				const after = findMember(db, before.userId);
				if (!after || after.proposes.join() === before.proposes.join()) return;
				record(
					now,
					"agent.updated",
					{ type: "agent", id: after.userId, label: after.name },
					{ from: before.proposes, to: after.proposes },
				);
			};
		}
		default:
			return null;
	}
}

function teamChanges(before: schema.TeamRow, after: schema.TeamRow): TeamChange[] {
	const changes: TeamChange[] = [];
	for (const change of ["name", "key"] as const) {
		if (before[change] !== after[change]) {
			changes.push({ change, from: before[change], to: after[change] });
		}
	}
	for (const change of ["archiveAfterMonths", "closeAfterMonths"] as const) {
		if (before[change] !== after[change]) {
			changes.push({ change, from: before[change], to: after[change] });
		}
	}
	const cycles = turned(before.cycles, after.cycles);
	if (cycles) changes.push({ change: "cycles", to: cycles === "renewed" ? "changed" : cycles });
	const form = turned(before.intakeFormKey, after.intakeFormKey);
	if (form) changes.push({ change: "intakeForm", to: form });
	const email = turned(before.intakeEmailKey, after.intakeEmailKey);
	if (email) changes.push({ change: "intakeEmail", to: email });
	return changes;
}

/** How a setting that is off when null went: on, off, or on differently. */
function turned(before: unknown, after: unknown): "on" | "renewed" | "off" | undefined {
	if (before === null && after !== null) return "on";
	if (before !== null && after === null) return "off";
	if (before !== null && JSON.stringify(before) !== JSON.stringify(after)) return "renewed";
	return undefined;
}

function findTeam(db: Db, id: string) {
	return db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
}

function findMember(db: Db, id: string) {
	return db.select().from(schema.members).where(eq(schema.members.userId, id)).get();
}

function teamTarget(team: schema.TeamRow): AuditTarget {
	return { type: "team", id: team.id, label: team.name };
}

function statusTarget(status: schema.StatusRow): AuditTarget {
	return { type: "status", id: status.id, label: status.name };
}

/** `ENG-12`, for a live issue. */
function liveIssueKey(db: Db, issueId: string): string | undefined {
	const row = db
		.select({ key: schema.teams.key, number: schema.issues.number })
		.from(schema.issues)
		.innerJoin(schema.teams, eq(schema.issues.teamId, schema.teams.id))
		.where(and(eq(schema.issues.id, issueId), isNull(schema.issues.deletedAt)))
		.get();
	return row && `${row.key}-${row.number}`;
}

// Integrations, which admins manage through the object's RPC.

/** A webhook by its host only: the rest of a URL can be its secret. */
export function webhookTarget(webhook: Pick<Webhook, "id" | "url">): AuditTarget {
	return { type: "webhook", id: webhook.id, label: hostOf(webhook.url) };
}

export function findWebhookRow(db: Db, id: string): schema.WebhookRow | undefined {
	return db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).get();
}

/** What changed in a webhook, one event each. */
export function webhookChanges(before: schema.WebhookRow, after: Webhook): AuditDetail[] {
	const changes: AuditDetail[] = [];
	if (before.url !== after.url) {
		changes.push({ change: "url", from: hostOf(before.url), to: hostOf(after.url) });
	}
	if (before.active !== after.active) changes.push({ change: "active", to: after.active });
	if (
		before.events.join() !== after.events.join() ||
		before.teamId !== after.teamId ||
		before.agentId !== after.agentId
	) {
		changes.push({ change: "events" });
	}
	return changes;
}

export function findGitHubRow(db: Db, id: string): schema.GitHubConnectionRow | undefined {
	return db
		.select()
		.from(schema.githubConnections)
		.where(eq(schema.githubConnections.id, id))
		.get();
}

/** A connection by the account it is on, or the repository it last heard from. */
export function githubTarget(
	row: Pick<schema.GitHubConnectionRow, "id" | "installationAccount" | "lastRepository">,
): AuditTarget {
	return { type: "github", id: row.id, label: row.installationAccount ?? row.lastRepository };
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}
