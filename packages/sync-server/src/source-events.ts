import {
	ASSIGNED_PER_DAY,
	BYTES_PER_DAY,
	CALLS_PER_MINUTE,
	EVENT_CLOCK_SKEW_MS,
	EVENT_MAX_BYTES,
	ISSUES_PER_DAY,
	type IssuePriority,
	isClosedCategory,
	LAST_HEARD_EVERY,
	LIVE_SIGNALS,
	liveStatuses,
	REOPENS_PER_KEY_PER_DAY,
	SIGNAL_KEPT_DAYS,
	type Signal,
	SOURCE_ACTOR_ID,
	type Source,
	sourceEventSchema,
	sourceIssueText,
	sourceLimitNotice,
	sourceReopenComment,
	WORKSPACE_ISSUES_PER_DAY,
	WRITES_PER_DAY,
} from "@gateweave/track-protocol";
import { and, count, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { recordActivity } from "./activity";
import { syncArchive } from "./archive";
import * as schema from "./db/schema";
import { notify } from "./inbox";
import { ChangeSet, type WriteResult } from "./log";
import { sortOrderAfterAll } from "./recurring";
import { indexComment, indexIssue } from "./search";
import { keyRevoked, liveConnectSeal } from "./source-management";
import { type Db, toComment, toIssue, toSignal, toSource } from "./state";
import { teamStatuses } from "./statuses";
import { queueDeliveries } from "./webhooks";

const DAY = 86_400_000;
const PRIORITY = { critical: 1, high: 2, medium: 3, low: 4, unknown: 0 } as const;

// Kept independently of the sources so removal and replacement cannot reset the workspace allowance.
const workspaceCounter = "source_issue_times";
// As with recurring issues, spread a large backlog across short alarm transactions.
const expiryBatch = 100;

type SourceRow = schema.SourceRow;
type SignalRow = schema.SignalRow;
type Issue = schema.IssueRow;
type Team = schema.TeamRow;
type Answer = {
	state: Signal["state"];
	filed: boolean;
	issue: { key: string; url: string } | null;
	reason?: string;
};
export type SourceEventResult =
	| { status: 400 | 404 | 503 }
	| { status: 429; retryAfter: number }
	| { status: 200; answer: Answer };
type Outcome = WriteResult & { response: SourceEventResult };

function parsedEvent(raw: string | null) {
	if (raw === null || new TextEncoder().encode(raw).length > EVENT_MAX_BYTES) return null;
	try {
		return sourceEventSchema.safeParse(JSON.parse(raw)).data ?? null;
	} catch {
		return null;
	}
}

function fileIssue(
	db: Db,
	changes: ChangeSet,
	team: Team,
	status: string,
	title: string,
	description: string | null,
	priority: IssuePriority,
	assigneeId: string | null,
): Issue {
	const number = team.issueCounter + 1;
	db.update(schema.teams).set({ issueCounter: number }).where(eq(schema.teams.id, team.id)).run();
	const issue: Issue = {
		id: crypto.randomUUID(),
		teamId: team.id,
		number,
		title,
		description,
		status,
		priority,
		assigneeId,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		creatorId: SOURCE_ACTOR_ID,
		labelIds: [],
		sortOrder: sortOrderAfterAll(db),
		version: changes.nextVersion,
		fieldStamps: {},
		createdAt: changes.now,
		updatedAt: changes.now,
		archivedAt: null,
		intake: false,
		deletedAt: null,
	};
	db.insert(schema.issues).values(issue).run();
	indexIssue(db, issue.id);
	changes.put("issue", toIssue(issue));
	changes.events.push({ type: "issue.created", issue });
	return issue;
}

function updateIssue(
	db: Db,
	changes: ChangeSet,
	source: SourceRow,
	issue: Issue,
	status: string | undefined,
	priority: IssuePriority,
	reopening: boolean,
): Issue {
	const patchStatus = status !== undefined && status !== issue.status;
	const raise = priority !== 0 && (issue.priority === 0 || priority < issue.priority);
	if (!patchStatus && !raise) return issue;
	const stamp = { version: changes.nextVersion, clientId: `source:${source.id}` };
	const row = {
		...issue,
		status: status ?? issue.status,
		priority: raise ? priority : issue.priority,
		fieldStamps: {
			...issue.fieldStamps,
			...(patchStatus && { status: stamp }),
			...(raise && { priority: stamp }),
		},
		archivedAt: reopening ? null : issue.archivedAt,
		version: stamp.version,
		updatedAt: changes.now,
	};
	db.update(schema.issues).set(row).where(eq(schema.issues.id, row.id)).run();
	changes.put("issue", toIssue(row));
	syncArchive(db, changes, issue, row);
	changes.events.push({ type: "issue.updated", issue: row, previous: issue });
	return row;
}

function addComment(db: Db, changes: ChangeSet, issueId: string, body: string) {
	const row: schema.CommentRow = {
		id: crypto.randomUUID(),
		issueId,
		authorId: SOURCE_ACTOR_ID,
		body,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(schema.comments).values(row).run();
	indexComment(db, row);
	changes.put("comment", toComment(row));
	changes.events.push({ type: "comment.created", comment: row });
}

function issueLink(db: Db, issue: Issue | undefined, workspaceUrl: string) {
	if (!issue) return null;
	const team = db
		.select({ key: schema.teams.key })
		.from(schema.teams)
		.where(eq(schema.teams.id, issue.teamId))
		.get();
	if (!team) return null;
	const key = `${team.key}-${issue.number}`;
	return { key, url: `${workspaceUrl}/issue/${encodeURIComponent(key)}` };
}

function finish(
	db: Db,
	changes: ChangeSet,
	source: SourceRow,
	response: SourceEventResult,
): Outcome {
	const wake = notify(db, changes, SOURCE_ACTOR_ID, false);
	const result = changes.result();
	const queued = queueDeliveries(
		db,
		{ id: SOURCE_ACTOR_ID, type: "system", name: source.name },
		changes.events,
		result.version,
		changes.now,
	);
	return { ...result, wake, queued, response };
}

function workspaceIssues(db: Db, now: number): number[] {
	const row = db.select().from(schema.meta).where(eq(schema.meta.key, workspaceCounter)).get();
	const times: number[] = row ? JSON.parse(row.value) : [];
	return times.filter((at) => at > now - DAY);
}

function countWorkspaceIssue(db: Db, times: number[], now: number) {
	const value = JSON.stringify([...times, now]);
	db.insert(schema.meta)
		.values({ key: workspaceCounter, value })
		.onConflictDoUpdate({ target: schema.meta.key, set: { value } })
		.run();
}

function refuse(
	db: Db,
	changes: ChangeSet,
	source: SourceRow,
	limit: string,
	reset: number,
): Outcome {
	const response = {
		status: 429,
		retryAfter: Math.max(1, Math.ceil((reset - changes.now) / 1000)),
	} as const;
	if (source.lastRefusedAt !== null && source.lastRefusedAt > changes.now - DAY)
		return { ...changes.result(), response };
	const notice = sourceLimitNotice(source.name, limit);
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, source.teamId)).get();
	const first = liveStatuses(teamStatuses(db, source.teamId))[0];
	if (!team || !first || isClosedCategory(first.category)) return { ...changes.result(), response };
	// The refusal notice is the single exception to refusing the event without filing anything.
	fileIssue(db, changes, team, first.key, notice.title, notice.description, 0, null);
	db.update(schema.sources)
		.set({ lastRefusedAt: changes.now })
		.where(eq(schema.sources.id, source.id))
		.run();
	return finish(db, changes, source, response);
}

function meetsThreshold(source: Source, severity: Signal["severity"]) {
	return severity === "unknown"
		? source.lowestSeverity === "low"
		: PRIORITY[severity] <= PRIORITY[source.lowestSeverity];
}

const closedFirstStatus = "The team's first status is closed.";

export function processSourceEvent(
	db: Db,
	sourceId: string,
	keyId: string,
	raw: string | null,
	workspaceUrl: string,
	now: number,
): Outcome {
	const changes = new ChangeSet(db, SOURCE_ACTOR_ID, now);
	liveConnectSeal(db, changes, sourceId);
	const source = db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).get();
	if (!source || keyRevoked(db, source.id, keyId))
		return { ...changes.result(), response: { status: 404 } };
	if (source.removing) return { ...changes.result(), response: { status: 503 } };
	if (source.paused) return { ...changes.result(), response: { status: 404 } };
	const calls = source.callTimes.filter((at) => at > now - 60_000);
	const recent = [...calls, now].slice(-CALLS_PER_MINUTE);
	// Admission accounting never takes a workspace version, even for late or unchanged events.
	db.update(schema.sources)
		.set({ callTimes: recent })
		.where(eq(schema.sources.id, source.id))
		.run();
	if (calls.length >= CALLS_PER_MINUTE)
		return refuse(db, changes, source, "CALLS_PER_MINUTE", (recent[0] ?? now) + 60_000);
	const event = parsedEvent(raw);
	if (!event || Date.parse(event.sentAt) > now + EVENT_CLOCK_SKEW_MS)
		return { ...changes.result(), response: { status: 400 } };
	const found = db
		.select()
		.from(schema.signals)
		.where(and(eq(schema.signals.sourceId, source.id), eq(schema.signals.key, event.key)))
		.get();
	const expired =
		found &&
		found.state !== "open" &&
		(found.clearedAt ?? found.changedAt) <= now - SIGNAL_KEPT_DAYS * DAY;
	const expiredId = expired ? found.id : undefined;
	const prior = expired ? undefined : found;
	if (!prior && event.state !== "open") {
		return {
			...changes.result(),
			response: { status: 200, answer: { state: event.state, filed: false, issue: null } },
		};
	}
	let issue = prior?.issueId
		? db
				.select()
				.from(schema.issues)
				.where(and(eq(schema.issues.id, prior.issueId), isNull(schema.issues.deletedAt)))
				.get()
		: undefined;
	const sentAt = Date.parse(event.sentAt);
	if (
		prior &&
		(sentAt <= prior.lastSentAt ||
			(event.state === prior.state && event.severity === prior.severity))
	) {
		// A newer report of the same state still orders later ones: one sent before it must not undo
		// it. The time is not in the replica, so recording it takes no version.
		if (sentAt > prior.lastSentAt)
			db.update(schema.signals)
				.set({ lastSentAt: sentAt })
				.where(eq(schema.signals.id, prior.id))
				.run();
		const first =
			!prior.issueId && prior.state === "open" && meetsThreshold(source, prior.severity)
				? liveStatuses(teamStatuses(db, source.teamId))[0]
				: undefined;
		const reason = first && isClosedCategory(first.category) ? closedFirstStatus : undefined;
		return {
			...changes.result(),
			response: {
				status: 200,
				answer: {
					state: prior.state,
					filed: !!issue,
					issue: issueLink(db, issue, workspaceUrl),
					...(reason && { reason }),
				},
			},
		};
	}
	const usage = source.usage.filter((entry) => entry.at > now - DAY);
	const reject = (limit: string, reset: number = now + DAY) =>
		refuse(db, changes, source, limit, reset);
	if (usage.length >= WRITES_PER_DAY) return reject("WRITES_PER_DAY", (usage[0]?.at ?? now) + DAY);
	if (event.state === "open" && prior?.state !== "open") {
		const open = db
			.select({ n: count() })
			.from(schema.signals)
			.where(and(eq(schema.signals.sourceId, source.id), eq(schema.signals.state, "open")))
			.get();
		if (open && open.n >= LIVE_SIGNALS) return reject("LIVE_SIGNALS");
	}
	const recurring = prior !== undefined && prior.state !== "open" && event.state === "open";
	const priority = PRIORITY[event.severity];
	const qualifies = meetsThreshold(source, event.severity);
	const filing = !issue && event.state === "open" && qualifies && (!prior?.issueId || recurring);
	const teamId = issue?.teamId ?? source.teamId;
	const team = db.select().from(schema.teams).where(eq(schema.teams.id, teamId)).get();
	const statuses = liveStatuses(teamStatuses(db, teamId));
	const first = statuses[0];
	const willFile = !!(filing && team && first && !isClosedCategory(first.category));
	const openStatus = statuses.find((s) => !isClosedCategory(s.category));
	const current = statuses.find((s) => s.key === issue?.status);
	const reopening = !!(recurring && current && isClosedCategory(current.category) && openStatus);
	const previousReopens = usage.filter((entry) => prior && entry.reopened === prior.id);
	if (reopening && previousReopens.length >= REOPENS_PER_KEY_PER_DAY)
		return reject("REOPENS_PER_KEY_PER_DAY", (previousReopens[0]?.at ?? now) + DAY);
	const filed = usage.filter((entry) => entry.filed);
	if (willFile && filed.length >= ISSUES_PER_DAY)
		return reject("ISSUES_PER_DAY", (filed[0]?.at ?? now) + DAY);
	const workspaceTimes = willFile ? workspaceIssues(db, now) : [];
	if (willFile && workspaceTimes.length >= WORKSPACE_ISSUES_PER_DAY)
		return reject("WORKSPACE_ISSUES_PER_DAY", (workspaceTimes[0] ?? now) + DAY);
	const text = willFile ? sourceIssueText(event, source) : null;
	const comment = reopening ? sourceReopenComment(source.name) : null;
	const url =
		event.url && source.linkOrigins.includes(new URL(event.url).origin) ? event.url : null;
	const bytes = new TextEncoder().encode(
		[
			event.key,
			event.type,
			event.subject,
			event.state,
			event.severity,
			url,
			text?.title,
			text?.description,
			comment,
		].join(""),
	).length;
	let excess = bytes + usage.reduce((total, entry) => total + entry.bytes, 0) - BYTES_PER_DAY;
	if (excess > 0) {
		for (const entry of usage) {
			excess -= entry.bytes;
			if (excess <= 0) return reject("BYTES_PER_DAY", entry.at + DAY);
		}
		return reject("BYTES_PER_DAY");
	}
	if (expiredId) {
		db.delete(schema.signals).where(eq(schema.signals.id, expiredId)).run();
		changes.delete("signal", expiredId);
	}
	let assigned = false;
	if (willFile && text && first && team) {
		const assignee =
			source.assigneeId && usage.filter((entry) => entry.assigned).length < ASSIGNED_PER_DAY
				? db
						.select()
						.from(schema.members)
						.where(
							and(
								eq(schema.members.userId, source.assigneeId),
								eq(schema.members.role, "agent"),
								isNull(schema.members.removedAt),
							),
						)
						.get()
				: undefined;
		assigned = !!assignee;
		issue = fileIssue(
			db,
			changes,
			team,
			first.key,
			text.title,
			text.description,
			priority,
			assignee?.userId ?? null,
		);
		countWorkspaceIssue(db, workspaceTimes, now);
	} else if (issue && prior) {
		const clearing = event.state !== "open" && prior.state !== event.state;
		const close =
			clearing &&
			source.closeWhenCleared &&
			(current?.category === "unstarted" || current?.category === "backlog");
		const target = reopening
			? openStatus
			: close
				? statuses.find(
						(s) => s.category === (event.state === "cleared" ? "completed" : "canceled"),
					)
				: undefined;
		const raised =
			priority !== 0 && (PRIORITY[prior.severity] === 0 || priority < PRIORITY[prior.severity]);
		issue = updateIssue(db, changes, source, issue, target?.key, raised ? priority : 0, reopening);
		if (clearing)
			recordActivity(db, changes, issue, SOURCE_ACTOR_ID, {
				type: "signal",
				from: prior.state,
				to: event.state,
			});
		if (comment) addComment(db, changes, issue.id, comment);
	}
	const signal: SignalRow = {
		id: prior?.id ?? crypto.randomUUID(),
		sourceId: source.id,
		key: event.key,
		type: event.type ?? null,
		subject: event.subject ?? null,
		severity: event.severity,
		state: event.state,
		url,
		issueId: issue?.id ?? prior?.issueId ?? null,
		reopens: (prior?.reopens ?? 0) + Number(reopening),
		firstAt: prior?.firstAt ?? now,
		changedAt: now,
		lastSentAt: sentAt,
		clearedAt:
			event.state === "open"
				? null
				: prior?.state === event.state
					? (prior.clearedAt ?? prior.changedAt)
					: now,
	};
	db.insert(schema.signals)
		.values(signal)
		.onConflictDoUpdate({ target: schema.signals.id, set: signal })
		.run();
	changes.put("signal", toSignal(signal));
	const heard = source.lastHeardAt === null || source.lastHeardAt <= now - LAST_HEARD_EVERY;
	usage.push({ at: now, bytes, filed: willFile, assigned, reopened: reopening ? signal.id : null });
	db.update(schema.sources)
		.set({ usage, ...(heard && { lastHeardAt: now }) })
		.where(eq(schema.sources.id, source.id))
		.run();
	if (heard) changes.put("source", toSource({ ...source, lastHeardAt: now }));
	const reason =
		filing && !willFile
			? closedFirstStatus
			: recurring && issue && !openStatus
				? "The team has no open status."
				: undefined;
	return finish(db, changes, source, {
		status: 200,
		answer: {
			state: signal.state,
			filed: !!issue,
			issue: issueLink(db, issue, workspaceUrl),
			...(reason && { reason }),
		},
	});
}

// Older dismissed rows carry the last known dismissal time only in changed_at.
const inactive = inArray(schema.signals.state, ["cleared", "dismissed"]);
const inactiveSince = sql<number>`coalesce(${schema.signals.clearedAt}, ${schema.signals.changedAt})`;

export function pruneExpiredSignals(db: Db, now: number) {
	const changes = new ChangeSet(db, SOURCE_ACTOR_ID, now);
	const expired = db
		.select({ id: schema.signals.id })
		.from(schema.signals)
		.where(and(inactive, lte(inactiveSince, now - SIGNAL_KEPT_DAYS * DAY)))
		.limit(expiryBatch)
		.all();
	for (const { id } of expired) {
		db.delete(schema.signals).where(eq(schema.signals.id, id)).run();
		changes.delete("signal", id);
	}
	return changes.result();
}

export function nextSignalExpiry(db: Db): number | null {
	const first = db
		.select({ at: sql<number | null>`min(${inactiveSince})` })
		.from(schema.signals)
		.where(inactive)
		.get()?.at;
	return first == null ? null : first + SIGNAL_KEPT_DAYS * DAY;
}
