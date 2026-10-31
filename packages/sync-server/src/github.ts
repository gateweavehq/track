import {
	type ActivitySource,
	CLOSED_STATUSES,
	GITHUB_ACTOR_ID,
	type GitHubConnection,
	type IssueStatus,
	MAX_GITHUB_CONNECTIONS,
	type PullRequestState,
	type WebhookActor,
} from "@gateweave/track-protocol";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "./activity";
import * as schema from "./db/schema";
import { notify } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import { MutationRejected } from "./rejected";
import { type Db, toIssue, toPullRequest } from "./state";
import { queueDeliveries } from "./webhooks";

/**
 * GitHub connections: webhooks on GitHub that report a workspace's pull requests and pushes. A
 * delivery's signature is checked against the connection's secret before its body is read. Pull
 * requests then link themselves to the issues they mention and move them on as they progress,
 * and commits on the default branch close the issues they say they fix. Every change is made as
 * GitHub, in one transaction per delivery, and a redelivery applies once.
 */

/** The connection's deliveries are recorded as mutations of this client, for idempotency. */
const GITHUB_CLIENT_ID = "github";

export const GITHUB_WEBHOOK_ACTOR: WebhookActor = {
	id: GITHUB_ACTOR_ID,
	name: "GitHub",
	type: "system",
};

/** A delivery as the gateway passes it on: the raw body, which the signature covers. */
export const githubDelivery = z.object({
	connectionId: z.string().min(1).max(64),
	/** `X-GitHub-Delivery`, unique per delivery and kept on redelivery. */
	deliveryId: z.string().min(1).max(64),
	/** `X-GitHub-Event`. */
	event: z.string().min(1).max(64),
	/** `X-Hub-Signature-256`. */
	signature: z.string().max(128).nullable(),
	body: z.string(),
});
export type GitHubDelivery = z.infer<typeof githubDelivery>;

// Settings, for admins. A secret is shown when it is made and never again.

export function listGitHubConnections(db: Db): GitHubConnection[] {
	return db
		.select()
		.from(schema.githubConnections)
		.orderBy(asc(schema.githubConnections.createdAt), asc(schema.githubConnections.id))
		.all()
		.map(toConnection);
}

export function createGitHubConnection(
	db: Db,
	memberId: string,
	now: number,
): { connection: GitHubConnection; secret: string } {
	const existing = db.select({ n: count() }).from(schema.githubConnections).get();
	if ((existing?.n ?? 0) >= MAX_GITHUB_CONNECTIONS) {
		throw new MutationRejected(
			"invalid",
			`A workspace can have at most ${MAX_GITHUB_CONNECTIONS} GitHub connections`,
		);
	}
	const row: schema.GitHubConnectionRow = {
		id: crypto.randomUUID(),
		secret: newSecret(),
		createdBy: memberId,
		createdAt: now,
		lastDeliveryAt: null,
		lastEvent: null,
		lastRepository: null,
	};
	db.insert(schema.githubConnections).values(row).run();
	return { connection: toConnection(row), secret: row.secret };
}

export function rotateGitHubSecret(db: Db, id: string): string {
	const secret = newSecret();
	const row = db
		.update(schema.githubConnections)
		.set({ secret })
		.where(eq(schema.githubConnections.id, id))
		.returning({ id: schema.githubConnections.id })
		.get();
	if (!row) throw new MutationRejected("not_found", "GitHub connection not found");
	return secret;
}

export function deleteGitHubConnection(db: Db, id: string): void {
	const row = db
		.delete(schema.githubConnections)
		.where(eq(schema.githubConnections.id, id))
		.returning({ id: schema.githubConnections.id })
		.get();
	if (!row) throw new MutationRejected("not_found", "GitHub connection not found");
}

// Deliveries

/**
 * Whether the delivery is signed with its connection's secret: GitHub's `X-Hub-Signature-256`,
 * an HMAC-SHA256 of the body. Null when there is no such connection.
 */
export async function verifyGitHubDelivery(
	db: Db,
	delivery: GitHubDelivery,
): Promise<boolean | null> {
	const connection = db
		.select({ secret: schema.githubConnections.secret })
		.from(schema.githubConnections)
		.where(eq(schema.githubConnections.id, delivery.connectionId))
		.get();
	if (!connection) return null;
	const hex = /^sha256=([0-9a-f]{64})$/i.exec(delivery.signature ?? "")?.[1];
	if (!hex) return false;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(connection.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	// `verify` compares in constant time.
	return crypto.subtle.verify("HMAC", key, fromHex(hex), encoder.encode(delivery.body));
}

/** Acts on a delivery whose signature checked out. Runs in one transaction. */
export function applyGitHubDelivery(db: Db, delivery: GitHubDelivery, now: number): WriteResult {
	const mutationId = `github:${delivery.deliveryId}`;
	const applied = db
		.select()
		.from(schema.appliedMutations)
		.where(eq(schema.appliedMutations.id, mutationId))
		.get();
	if (applied) return { version: applied.version, ops: [] };

	// A body that is not what GitHub sends for the event is skipped, not refused: GitHub would
	// only deliver it again.
	const body = parseJson(delivery.body);
	const from = origin.safeParse(body);
	db.update(schema.githubConnections)
		.set({
			lastDeliveryAt: now,
			lastEvent: delivery.event,
			lastRepository: from.success
				? (from.data.repository?.full_name ?? from.data.organization?.login ?? null)
				: null,
		})
		.where(eq(schema.githubConnections.id, delivery.connectionId))
		.run();

	const changes = new ChangeSet(db, GITHUB_ACTOR_ID, now);
	const github = new GitHubEvents(db, changes);
	if (delivery.event === "pull_request") {
		const payload = pullRequestPayload.safeParse(body);
		if (payload.success) github.pullRequest(payload.data);
	} else if (delivery.event === "push") {
		const payload = pushPayload.safeParse(body);
		if (payload.success) github.push(payload.data);
	}

	notify(db, changes, GITHUB_ACTOR_ID, false);
	const result = changes.result();
	db.insert(schema.appliedMutations)
		.values({ id: mutationId, clientId: GITHUB_CLIENT_ID, version: result.version, at: now })
		.run();
	const queued = queueDeliveries(db, GITHUB_WEBHOOK_ACTOR, changes.events, result.version, now);
	return { ...result, queued };
}

// The parts of GitHub's payloads that matter here.

/** Where any delivery came from: a repository, or for an organization's ping, the organization. */
const origin = z.object({
	repository: z.object({ full_name: z.string().max(200) }).optional(),
	organization: z.object({ login: z.string().max(100) }).optional(),
});

const pullRequestPayload = z.object({
	action: z.string(),
	repository: z.object({ full_name: z.string() }),
	pull_request: z.object({
		id: z.number(),
		number: z.number().int(),
		title: z.string(),
		body: z.string().nullable(),
		html_url: z.string(),
		state: z.enum(["open", "closed"]),
		draft: z.boolean().optional(),
		merged_at: z.string().nullable().optional(),
		head: z.object({ ref: z.string() }),
		user: z.object({ login: z.string() }).nullable(),
		created_at: z.string(),
	}),
});
type PullRequestPayload = z.infer<typeof pullRequestPayload>;

const pushPayload = z.object({
	ref: z.string(),
	repository: z.object({ full_name: z.string(), default_branch: z.string() }),
	commits: z.array(
		z.object({
			id: z.string(),
			message: z.string(),
			url: z.string(),
			/** False for a commit an earlier push to another branch already brought. */
			distinct: z.boolean().optional(),
		}),
	),
});
type PushPayload = z.infer<typeof pushPayload>;

/** Actions that change what a pull request's state means for its issues. */
const STATE_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "converted_to_draft"]);

/** How far along each status is. Issues only move forward, and never out of a closed status. */
const PROGRESS: Record<IssueStatus, number> = {
	backlog: 0,
	todo: 1,
	in_progress: 2,
	in_review: 3,
	done: 4,
	canceled: 4,
};

/** Keys a pull request can link, at most: past this, a long body is not worth reading. */
const MAX_REFERENCES = 50;

/** A key as it may appear in text: a team key and a number, in any case. */
const KEY = /\b([a-z][a-z0-9]{0,6})-(\d{1,9})\b/gi;
/** A closing word, then a key: "Fixes TRK-12", "closes: trk-12". */
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+([a-z][a-z0-9]{0,6}-\d{1,9})\b/gi;

interface Reference {
	issue: schema.IssueRow;
	closing: boolean;
}

class GitHubEvents {
	/** The workspace's teams by key, loaded when first needed. */
	#teams: Map<string, string> | undefined;

	constructor(
		private readonly db: Db,
		private readonly changes: ChangeSet,
	) {}

	pullRequest({ action, repository, pull_request: pr }: PullRequestPayload): void {
		const id = `github:${pr.id}`;
		const existing = this.db
			.select()
			.from(schema.pullRequests)
			.where(eq(schema.pullRequests.id, id))
			.get();
		// The branch was named for the issue, so merging it closes the issue.
		const references = this.#resolve([
			...mentions(pr.head.ref, true),
			...mentions(pr.title),
			...mentions(pr.body ?? ""),
		]);
		if (!existing && references.size === 0) return;

		const state = pullRequestState(pr);
		const row: schema.PullRequestRow = {
			id,
			repository: repository.full_name,
			number: pr.number,
			title: pr.title,
			url: pr.html_url,
			state,
			branch: pr.head.ref,
			author: pr.user?.login ?? null,
			issueIds: [...references.keys()],
			closingIssueIds: [...references].filter(([, ref]) => ref.closing).map(([key]) => key),
			createdAt: existing?.createdAt ?? (Date.parse(pr.created_at) || this.changes.now),
			updatedAt: this.changes.now,
		};
		if (!existing || !samePullRequest(existing, row)) {
			this.db
				.insert(schema.pullRequests)
				.values(row)
				.onConflictDoUpdate({ target: schema.pullRequests.id, set: row })
				.run();
			this.changes.put("pullRequest", toPullRequest(row));
		}

		const source: ActivitySource = {
			type: "pull_request",
			label: `${repository.full_name}#${pr.number}`,
			url: pr.html_url,
		};
		const linked = new Set(existing?.issueIds);
		const moved = STATE_ACTIONS.has(action) || (action === "closed" && state === "merged");
		for (const [issueId, reference] of references) {
			// An edit or a new commit says nothing new about issues that were already linked, and
			// someone may have moved them on purpose since.
			if (!moved && linked.has(issueId)) continue;
			const target = targetStatus(state, reference.closing);
			if (target) this.#advance(issueId, target, source);
		}
	}

	push({ ref, repository, commits }: PushPayload): void {
		if (ref !== `refs/heads/${repository.default_branch}`) return;
		for (const commit of commits) {
			if (commit.distinct === false) continue;
			const closing = mentions(commit.message).filter((mention) => mention.closing);
			const source: ActivitySource = {
				type: "commit",
				label: `${repository.full_name}@${commit.id.slice(0, 7)}`,
				url: commit.url,
			};
			for (const issueId of this.#resolve(closing).keys()) this.#advance(issueId, "done", source);
		}
	}

	/** Moves an issue to a status further along, as GitHub. */
	#advance(issueId: string, target: IssueStatus, source: ActivitySource): void {
		// Read again: an earlier commit of the same push may have moved it.
		const issue = this.db
			.select()
			.from(schema.issues)
			.where(and(eq(schema.issues.id, issueId), isNull(schema.issues.deletedAt)))
			.get();
		if (!issue || CLOSED_STATUSES.includes(issue.status)) return;
		if (PROGRESS[issue.status] >= PROGRESS[target]) return;

		const version = this.changes.nextVersion;
		// The stamp makes a stale offline edit to the status conflict rather than undo this.
		const fieldStamps = { ...issue.fieldStamps, status: { version, clientId: GITHUB_CLIENT_ID } };
		const row = this.db
			.update(schema.issues)
			.set({ status: target, fieldStamps, version, updatedAt: this.changes.now })
			.where(eq(schema.issues.id, issue.id))
			.returning()
			.get();
		if (!row) return;
		this.changes.put("issue", toIssue(row));
		this.changes.events.push({ type: "issue.updated", issue: row, previous: issue });
		const change = { type: "status", from: issue.status, to: target } as const;
		recordActivity(this.db, this.changes, issue, GITHUB_ACTOR_ID, change, null, source);
	}

	/** The live issues that mentions name, by id. A closing mention of an issue wins. */
	#resolve(mentioned: Mention[]): Map<string, Reference> {
		this.#teams ??= new Map(
			this.db
				.select({ id: schema.teams.id, key: schema.teams.key })
				.from(schema.teams)
				.all()
				.map((team) => [team.key, team.id]),
		);
		// By key; null for a key that names no live issue.
		const byKey = new Map<string, Reference | null>();
		for (const { teamKey, number, closing } of mentioned) {
			const key = `${teamKey}-${number}`;
			const known = byKey.get(key);
			if (known !== undefined) {
				if (known) known.closing ||= closing;
				continue;
			}
			if (byKey.size >= MAX_REFERENCES) break;
			const teamId = this.#teams.get(teamKey);
			const issue =
				teamId === undefined
					? undefined
					: this.db
							.select()
							.from(schema.issues)
							.where(
								and(
									eq(schema.issues.teamId, teamId),
									eq(schema.issues.number, number),
									isNull(schema.issues.deletedAt),
								),
							)
							.get();
			byKey.set(key, issue ? { issue, closing } : null);
		}
		const found = new Map<string, Reference>();
		for (const reference of byKey.values()) {
			if (reference) found.set(reference.issue.id, reference);
		}
		return found;
	}
}

interface Mention {
	teamKey: string;
	number: number;
	closing: boolean;
}

/**
 * The issue keys in a piece of text, uppercased. Each is closing when `closing` says so (as for a
 * branch name) or when a closing word comes right before it.
 */
export function mentions(text: string, closing = false): Mention[] {
	const closed = new Set<string>();
	for (const match of text.matchAll(CLOSING)) {
		for (const mention of mentions(match[1] ?? ""))
			closed.add(`${mention.teamKey}-${mention.number}`);
	}
	const found: Mention[] = [];
	for (const match of text.matchAll(KEY)) {
		const teamKey = (match[1] ?? "").toUpperCase();
		const number = Number(match[2]);
		found.push({ teamKey, number, closing: closing || closed.has(`${teamKey}-${number}`) });
	}
	return found;
}

function pullRequestState(pr: PullRequestPayload["pull_request"]): PullRequestState {
	if (pr.merged_at) return "merged";
	if (pr.state === "closed") return "closed";
	return pr.draft ? "draft" : "open";
}

/** Where a pull request in this state takes the issues it links. */
function targetStatus(state: PullRequestState, closing: boolean): IssueStatus | null {
	switch (state) {
		case "draft":
			return "in_progress";
		case "open":
			return "in_review";
		case "merged":
			return closing ? "done" : null;
		case "closed":
			return null;
	}
}

function samePullRequest(a: schema.PullRequestRow, b: schema.PullRequestRow): boolean {
	return (
		a.title === b.title &&
		a.state === b.state &&
		a.branch === b.branch &&
		a.repository === b.repository &&
		a.url === b.url &&
		a.author === b.author &&
		a.issueIds.join() === b.issueIds.join() &&
		a.closingIssueIds.join() === b.closingIssueIds.join()
	);
}

function toConnection({ secret: _, ...row }: schema.GitHubConnectionRow): GitHubConnection {
	return row;
}

function newSecret(): string {
	return [...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1)
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
