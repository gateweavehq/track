import {
	type Issue,
	MAX_WEBHOOKS_PER_WORKSPACE,
	SYSTEM_ACTOR_ID,
	WEBHOOK_TEST_EVENT,
	type Webhook,
	type WebhookActor,
	type WebhookDelivery,
	type WebhookInput,
	type WebhookIssue,
	type WebhookPatch,
	type WebhookPayload,
	webhookInput,
	webhookPatch,
} from "@gateweave/track-protocol";
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, min, ne } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./db/schema";
import { MutationRejected } from "./rejected";
import { type Db, toComment, toIssue, toProposal } from "./state";

/**
 * Webhooks, delivered by the workspace's own Durable Object. A change queues its deliveries in
 * the transaction that makes it (an outbox), so a delivery is never lost and never sent for a
 * change that rolled back. The alarm sends them, outside any transaction, and retries failures.
 */

/** Where the workspace lives, for payloads and links. The gateway records it with each change. */
export interface WorkspaceLink {
	id: string;
	slug: string;
	/** The app's origin, such as `https://track.example.com`. */
	origin: string;
}

export const workspaceLink = z.object({
	id: z.string().min(1).max(64),
	slug: z.string().min(1).max(64),
	origin: z.url({ protocol: /^https?$/ }),
});

/** What a mutation did, in the terms webhooks report. Handlers add these to their change set. */
export type ChangeEvent =
	| { type: "issue.created" | "issue.deleted"; issue: schema.IssueRow }
	| { type: "issue.updated"; issue: schema.IssueRow; previous: schema.IssueRow }
	| {
			type: "comment.created" | "comment.updated" | "comment.deleted";
			comment: schema.CommentRow;
	  }
	| { type: "proposal.created" | "proposal.updated"; proposal: schema.ProposalRow }
	// The row as decided: it carries who decided it and when.
	| { type: "proposal.accepted" | "proposal.dismissed"; proposal: schema.ProposalRow }
	// The row as it was. Also removed, one by one, when either of its issues is deleted.
	| { type: "relation.created" | "relation.deleted"; relation: schema.RelationRow };

/** How long a receiver has to answer. */
export const DELIVERY_TIMEOUT_MS = 10_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The waits before each retry, so a delivery gets one attempt more than there are delays. */
export const RETRY_DELAYS_MS = [5_000, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 5 * HOUR, 10 * HOUR];

/** Finished deliveries are kept this long, for settings to show. */
export const DELIVERY_RETENTION_MS = 7 * 24 * HOUR;

const RECENT_DELIVERIES = 10;
const BATCH_SIZE = 50;
const CONCURRENCY = 10;
/** A claimed delivery is due again after this, in case the object restarts while sending it. */
const CLAIM_MS = DELIVERY_TIMEOUT_MS + MINUTE;
const LINK_KEY = "workspace_link";
/** Durable Object SQLite binds at most 100 parameters per statement. */
const LABEL_LOOKUP_CHUNK = 90;
const SECRET_PREFIX = "whsec_";

// Recording, inside the mutation's transaction.

/** Records where the workspace lives. Cheap when nothing changed, so gateways call it freely. */
export function saveLink(db: Db, link: WorkspaceLink): void {
	const value = JSON.stringify(workspaceLink.parse(link));
	db.insert(schema.meta)
		.values({ key: LINK_KEY, value })
		.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
		.run();
}

/** Follows a change of the workspace's slug, if webhooks ever recorded a link. */
export function renameLink(db: Db, slug: string): void {
	const link = readLink(db);
	if (link) saveLink(db, { ...link, slug });
}

function readLink(db: Db): WorkspaceLink | undefined {
	const row = db.select().from(schema.meta).where(eq(schema.meta.key, LINK_KEY)).get();
	return row ? workspaceLink.parse(JSON.parse(row.value)) : undefined;
}

/**
 * Queues a delivery of each event to each active webhook that wants it. Returns how many. The
 * actor is the member who made the change, or who made it on the server's side: Track itself when
 * null, or an integration such as GitHub.
 */
export function queueDeliveries(
	db: Db,
	actor: schema.MemberRow | WebhookActor | null,
	events: readonly ChangeEvent[],
	version: number,
	now: number,
): number {
	if (events.length === 0) return 0;
	const webhooks = db.select().from(schema.webhooks).where(eq(schema.webhooks.active, true)).all();
	// Webhooks are made through a gateway, which records the link first.
	const link = readLink(db);
	if (webhooks.length === 0 || !link) return 0;

	const payloads = new Payloads(db, link, actor, version, now);
	let queued = 0;
	for (const event of events) {
		const built = payloads.build(event);
		if (!built) continue;
		for (const webhook of webhooks) {
			if (!webhook.events.includes(event.type)) continue;
			if (webhook.teamId !== null && !built.teamIds.includes(webhook.teamId)) continue;
			// An agent's own changes would set it off again.
			if (actor && "userId" in actor && webhook.agentId === actor.userId) continue;
			insertDelivery(db, webhook.id, event.type, built.body, now);
			queued += 1;
		}
	}
	return queued;
}

function insertDelivery(
	db: Db,
	webhookId: string,
	event: WebhookDelivery["event"],
	body: string,
	now: number,
): void {
	db.insert(schema.webhookDeliveries)
		.values({
			id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
			webhookId,
			event,
			payload: body,
			status: "pending",
			attempts: 0,
			nextAttemptAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

/** Builds each event's body once, however many webhooks get it. */
class Payloads {
	readonly #teamKeys = new Map<string, string>();
	readonly #actor: WebhookActor;
	readonly #timestamp: string;

	constructor(
		private readonly db: Db,
		private readonly link: WorkspaceLink,
		actor: schema.MemberRow | WebhookActor | null,
		private readonly version: number,
		now: number,
	) {
		if (actor === null) this.#actor = { id: SYSTEM_ACTOR_ID, name: "Track", type: "system" };
		else if ("userId" in actor) {
			const type = actor.role === "agent" ? "agent" : "person";
			this.#actor = { id: actor.userId, name: actor.name, type };
		} else this.#actor = actor;
		this.#timestamp = new Date(now).toISOString();
	}

	/** `teamIds` are the teams whose webhooks hear it: a relation can join two teams' issues. */
	build(event: ChangeEvent): { teamIds: string[]; body: string } | undefined {
		let issueRow: schema.IssueRow | undefined;
		if ("issue" in event) issueRow = event.issue;
		else if ("comment" in event) issueRow = this.#issue(event.comment.issueId);
		else if ("proposal" in event) issueRow = this.#issue(event.proposal.issueId);
		else issueRow = this.#issue(event.relation.issueId);
		if (!issueRow) return undefined;
		const issue = this.#webhookIssue(issueRow);
		const change = {
			workspace: { id: this.link.id, slug: this.link.slug },
			version: this.version,
			actor: this.#actor,
			issue,
		};

		let payload: WebhookPayload;
		let teamIds = [issueRow.teamId];
		if ("relation" in event) {
			// A deleted issue keeps its row, so a relation removed along with it still resolves.
			const related = this.#issue(event.relation.relatedIssueId);
			if (!related) return undefined;
			teamIds = [...new Set([issueRow.teamId, related.teamId])];
			payload = {
				type: event.type,
				timestamp: this.#timestamp,
				data: { ...change, relatedIssue: this.#webhookIssue(related), relation: event.relation },
			};
		} else if (event.type === "issue.updated") {
			const from = updatedFrom(toIssue(event.previous), toIssue(event.issue));
			// Only the manual order changed, which is not worth telling anyone.
			if (Object.keys(from).length === 0) return undefined;
			payload = {
				type: event.type,
				timestamp: this.#timestamp,
				data: { ...change, updatedFrom: from },
			};
		} else if ("proposal" in event) {
			const proposal = { ...toProposal(event.proposal), issueKey: issue.key };
			if (event.type === "proposal.created" || event.type === "proposal.updated") {
				payload = { type: event.type, timestamp: this.#timestamp, data: { ...change, proposal } };
			} else {
				// A person decides on their own mutation, and an agent withdraws with its own.
				payload = {
					type: event.type,
					timestamp: this.#timestamp,
					data: {
						...change,
						proposal,
						decidedBy: this.#actor,
						decidedAt: event.proposal.decidedAt ?? 0,
					},
				};
			}
		} else if ("comment" in event) {
			payload = {
				type: event.type,
				timestamp: this.#timestamp,
				data: { ...change, comment: toComment(event.comment) },
			};
		} else {
			payload = { type: event.type, timestamp: this.#timestamp, data: change };
		}
		return { teamIds, body: JSON.stringify(payload) };
	}

	#issue(id: string) {
		return this.db.select().from(schema.issues).where(eq(schema.issues.id, id)).get();
	}

	#webhookIssue(row: schema.IssueRow): WebhookIssue {
		let teamKey = this.#teamKeys.get(row.teamId);
		if (teamKey === undefined) {
			const team = this.db
				.select({ key: schema.teams.key })
				.from(schema.teams)
				.where(eq(schema.teams.id, row.teamId))
				.get();
			teamKey = team?.key ?? "";
			this.#teamKeys.set(row.teamId, teamKey);
		}
		const key = `${teamKey}-${row.number}`;
		const url = new URL(`/${encodeURIComponent(this.link.slug)}/issue/${key}`, this.link.origin);
		return { ...toIssue(row), key, url: url.href, labels: this.#labelsOf(row.labelIds) };
	}

	/**
	 * Reads the names now, since labels get renamed: nothing is cached past this payload. Ids
	 * are looked up in chunks, as Durable Object SQLite allows only so many bound parameters.
	 */
	#labelsOf(ids: readonly string[]): { id: string; name: string }[] {
		const names = new Map<string, string>();
		for (let start = 0; start < ids.length; start += LABEL_LOOKUP_CHUNK) {
			const rows = this.db
				.select({ id: schema.labels.id, name: schema.labels.name })
				.from(schema.labels)
				.where(inArray(schema.labels.id, ids.slice(start, start + LABEL_LOOKUP_CHUNK)))
				.all();
			for (const row of rows) names.set(row.id, row.name);
		}
		// In the order of labelIds, leaving out any id with no row.
		return ids.flatMap((id) => {
			const name = names.get(id);
			return name === undefined ? [] : [{ id, name }];
		});
	}
}

/** Fields that change with every write, or only reorder the list, are not changes to report. */
const UNREPORTED: ReadonlySet<keyof Issue> = new Set(["version", "updatedAt", "sortOrder"]);

function updatedFrom(previous: Issue, issue: Issue): Partial<Issue> {
	const from: Record<string, unknown> = {};
	for (const field of Object.keys(issue) as (keyof Issue)[]) {
		if (UNREPORTED.has(field)) continue;
		if (JSON.stringify(previous[field]) !== JSON.stringify(issue[field])) {
			from[field] = previous[field];
		}
	}
	return from as Partial<Issue>;
}

// Management, by admins through a gateway. Each runs inside a transaction.

export interface WebhookList {
	webhooks: Webhook[];
	/** Each webhook's latest deliveries, newest first. */
	deliveries: WebhookDelivery[];
}

export function listWebhooks(db: Db): WebhookList {
	const rows = db.select().from(schema.webhooks).orderBy(asc(schema.webhooks.createdAt)).all();
	const deliveries = rows.flatMap((row) =>
		db
			.select()
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.webhookId, row.id))
			.orderBy(desc(schema.webhookDeliveries.createdAt))
			.limit(RECENT_DELIVERIES)
			.all()
			.map(toDelivery),
	);
	return { webhooks: rows.map(toWebhook), deliveries };
}

export function createWebhook(
	db: Db,
	link: WorkspaceLink,
	input: WebhookInput,
	now: number,
): { webhook: Webhook; secret: string } {
	const fields = parse(webhookInput, input);
	checkUrl(fields.url, link);
	const existing = db.select({ n: count() }).from(schema.webhooks).get();
	if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE) {
		throw new MutationRejected(
			"invalid",
			`A workspace can have at most ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks`,
		);
	}
	checkTargets(db, fields);

	const secret = newSecret();
	const row: schema.WebhookRow = {
		id: crypto.randomUUID(),
		...fields,
		secret,
		active: true,
		createdAt: now,
		updatedAt: now,
	};
	db.insert(schema.webhooks).values(row).run();
	return { webhook: toWebhook(row), secret };
}

export function updateWebhook(
	db: Db,
	link: WorkspaceLink,
	id: string,
	patch: WebhookPatch,
	now: number,
): Webhook {
	const webhook = findWebhook(db, id);
	const fields = parse(webhookPatch, patch);
	if (fields.url !== undefined) checkUrl(fields.url, link);
	checkTargets(db, fields);

	const row = db
		.update(schema.webhooks)
		.set({ ...fields, updatedAt: now })
		.where(eq(schema.webhooks.id, webhook.id))
		.returning()
		.get();
	if (!row) throw new MutationRejected("not_found", "Webhook not found");
	// Pausing stops what was still on its way, too.
	if (!row.active) failPending(db, row.id, "Webhook paused", now);
	return toWebhook(row);
}

export function deleteWebhook(db: Db, id: string): void {
	const webhook = findWebhook(db, id);
	db.delete(schema.webhookDeliveries)
		.where(eq(schema.webhookDeliveries.webhookId, webhook.id))
		.run();
	db.delete(schema.webhooks).where(eq(schema.webhooks.id, webhook.id)).run();
}

/** Replaces the secret. Deliveries signed with the old one fail until the receiver has the new. */
export function rotateSecret(db: Db, id: string, now: number): string {
	const webhook = findWebhook(db, id);
	const secret = newSecret();
	db.update(schema.webhooks)
		.set({ secret, updatedAt: now })
		.where(eq(schema.webhooks.id, webhook.id))
		.run();
	return secret;
}

/** Queues a `webhook.test` delivery, whatever events the webhook subscribes to. */
export function queueTest(db: Db, id: string, now: number): void {
	const webhook = findWebhook(db, id);
	if (!webhook.active) throw new MutationRejected("invalid", "Resume the webhook first");
	const link = readLink(db);
	if (!link) throw new MutationRejected("invalid", "The workspace has no link yet");
	const payload: WebhookPayload = {
		type: WEBHOOK_TEST_EVENT,
		timestamp: new Date(now).toISOString(),
		data: { workspace: { id: link.id, slug: link.slug }, webhookId: webhook.id },
	};
	insertDelivery(db, webhook.id, WEBHOOK_TEST_EVENT, JSON.stringify(payload), now);
}

/**
 * Where webhooks may point. Plain http only where the app itself runs on it, which is local
 * development. Never at the app's own host: a Worker cannot fetch itself, and it is no receiver
 * anyway.
 */
function checkUrl(url: string, link: WorkspaceLink): void {
	const target = new URL(url);
	const app = new URL(link.origin);
	if (target.protocol !== "https:" && app.protocol === "https:") {
		throw new MutationRejected("invalid", "Use an https URL");
	}
	if (target.host === app.host) {
		throw new MutationRejected("invalid", "A webhook cannot point at Track itself");
	}
	if (target.username || target.password) {
		throw new MutationRejected("invalid", "Leave the user name and password out of the URL");
	}
}

function checkTargets(db: Db, fields: { teamId?: string | null; agentId?: string | null }) {
	if (fields.teamId) {
		const team = db
			.select({ id: schema.teams.id })
			.from(schema.teams)
			.where(eq(schema.teams.id, fields.teamId))
			.get();
		if (!team) throw new MutationRejected("not_found", "Team not found");
	}
	if (fields.agentId) {
		const agent = db
			.select({ role: schema.members.role })
			.from(schema.members)
			.where(eq(schema.members.userId, fields.agentId))
			.get();
		if (agent?.role !== "agent") throw new MutationRejected("not_found", "Agent not found");
	}
}

function findWebhook(db: Db, id: string): schema.WebhookRow {
	const webhook = db.select().from(schema.webhooks).where(eq(schema.webhooks.id, id)).get();
	if (!webhook) throw new MutationRejected("not_found", "Webhook not found");
	return webhook;
}

function parse<T extends z.ZodType>(schemaOf: T, value: unknown): z.output<T> {
	const result = schemaOf.safeParse(value);
	if (!result.success) throw new MutationRejected("invalid", z.prettifyError(result.error));
	return result.data;
}

function failPending(db: Db, webhookId: string, error: string, now: number): void {
	db.update(schema.webhookDeliveries)
		.set({ status: "failed", error, nextAttemptAt: null, updatedAt: now })
		.where(
			and(
				eq(schema.webhookDeliveries.webhookId, webhookId),
				eq(schema.webhookDeliveries.status, "pending"),
			),
		)
		.run();
}

function newSecret(): string {
	return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(24)));
}

function toWebhook({ secret, ...row }: schema.WebhookRow): Webhook {
	return { ...row, secretStart: secret.slice(0, SECRET_PREFIX.length + 4) };
}

function toDelivery({ payload: _, ...row }: schema.WebhookDeliveryRow): WebhookDelivery {
	return row;
}

// Delivery, from the alarm.

interface Claim {
	id: string;
	url: string;
	secret: string;
	payload: string;
	attempts: number;
}

type Outcome = { ok: boolean; responseStatus: number | null; error: string | null };

/** Runs a write in a storage transaction. Delivery awaits between writes, never inside one. */
export type Transact = <T>(fn: () => T) => T;

/** Sends the deliveries that are due. Returns whether more were due than one round sends. */
export async function deliverDue(db: Db, transact: Transact): Promise<boolean> {
	const claims = transact(() => claimDue(db, Date.now()));
	let next = 0;
	const worker = async () => {
		while (next < claims.length) {
			const claim = claims[next++];
			if (!claim) break;
			const outcome = await attempt(claim);
			transact(() => recordOutcome(db, claim, outcome, Date.now()));
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claims.length) }, worker));
	return claims.length === BATCH_SIZE;
}

/** When the next pending delivery is due, if any is. */
export function nextDeliveryAt(db: Db): number | null {
	const row = db
		.select({ at: min(schema.webhookDeliveries.nextAttemptAt) })
		.from(schema.webhookDeliveries)
		.where(eq(schema.webhookDeliveries.status, "pending"))
		.get();
	return row?.at ?? null;
}

/** Drops finished deliveries past their retention. Runs with compaction. */
export function pruneDeliveries(db: Db, now: number): void {
	db.delete(schema.webhookDeliveries)
		.where(
			and(
				ne(schema.webhookDeliveries.status, "pending"),
				lt(schema.webhookDeliveries.updatedAt, now - DELIVERY_RETENTION_MS),
			),
		)
		.run();
}

/** Takes the due deliveries and moves their next attempt out of the way while they are sent. */
function claimDue(db: Db, now: number): Claim[] {
	const due = db
		.select({
			id: schema.webhookDeliveries.id,
			url: schema.webhooks.url,
			secret: schema.webhooks.secret,
			payload: schema.webhookDeliveries.payload,
			attempts: schema.webhookDeliveries.attempts,
		})
		.from(schema.webhookDeliveries)
		.innerJoin(schema.webhooks, eq(schema.webhooks.id, schema.webhookDeliveries.webhookId))
		.where(
			and(
				eq(schema.webhookDeliveries.status, "pending"),
				isNotNull(schema.webhookDeliveries.nextAttemptAt),
				lte(schema.webhookDeliveries.nextAttemptAt, now),
			),
		)
		.orderBy(asc(schema.webhookDeliveries.nextAttemptAt))
		.limit(BATCH_SIZE)
		.all();
	if (due.length > 0) {
		db.update(schema.webhookDeliveries)
			.set({ nextAttemptAt: now + CLAIM_MS, updatedAt: now })
			.where(
				inArray(
					schema.webhookDeliveries.id,
					due.map((claim) => claim.id),
				),
			)
			.run();
	}
	return due.map((claim) => ({ ...claim, attempts: claim.attempts + 1 }));
}

async function attempt(claim: Claim): Promise<Outcome> {
	const timestamp = Math.floor(Date.now() / 1000);
	try {
		const response = await fetch(claim.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Gateweave-Track-Webhooks/1",
				"webhook-id": claim.id,
				"webhook-timestamp": String(timestamp),
				"webhook-signature": await sign(claim.secret, claim.id, timestamp, claim.payload),
			},
			body: claim.payload,
			// A redirect could lead anywhere, so it counts as a failure.
			redirect: "manual",
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
		});
		await response.body?.cancel();
		return {
			ok: response.ok,
			responseStatus: response.status,
			error: response.ok ? null : `The receiver answered ${response.status}`,
		};
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			responseStatus: null,
			error: timedOut
				? `No answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds`
				: `Could not reach the receiver: ${describe(error)}`,
		};
	}
}

function recordOutcome(db: Db, claim: Claim, outcome: Outcome, now: number): void {
	const delay = RETRY_DELAYS_MS[claim.attempts - 1];
	const status = outcome.ok ? "delivered" : delay === undefined ? "failed" : "pending";
	db.update(schema.webhookDeliveries)
		.set({
			status,
			attempts: claim.attempts,
			responseStatus: outcome.responseStatus,
			error: outcome.error,
			nextAttemptAt: status === "pending" && delay !== undefined ? now + delay : null,
			updatedAt: now,
		})
		// Paused or deleted while it was being sent: leave it as that made it.
		.where(
			and(
				eq(schema.webhookDeliveries.id, claim.id),
				eq(schema.webhookDeliveries.status, "pending"),
			),
		)
		.run();
}

/** A Standard Webhooks signature: HMAC-SHA256 of `id.timestamp.body`, keyed by the secret. */
export async function sign(
	secret: string,
	id: string,
	timestamp: number,
	body: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		fromBase64(secret.slice(SECRET_PREFIX.length)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${toBase64(new Uint8Array(mac))}`;
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 200);
}
