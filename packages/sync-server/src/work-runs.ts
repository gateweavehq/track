import {
	type ClaimWorkRunInput,
	isAdminRole,
	LIVE_RUNS,
	type ReconcileWorkRunInput,
	type RegisterWorkRunInput,
	type ReportWorkRunInput,
	type RunState,
	UNFINISHED_RUN_STATES,
} from "@gateweave/track-protocol";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import {
	type IssueRow,
	type SignalRow,
	signals,
	sources,
	workRunAttempts,
	workRunRequests,
} from "./db/schema";
import { ChangeSet, type WriteResult } from "./log";
import { findIssueRowById, findIssueRowByKey } from "./queries";
import { liveConnectSeal } from "./source-management";
import { activeMember, type Db, toSignal } from "./state";

type RequestRow = typeof workRunRequests.$inferSelect;
type Failure = { status: 400 | 403 | 404 | 409; error: string };
type Result<T> = Failure | { status: 200 | 201; value: T };
type Write<T> = WriteResult & { response: Result<T> };

function respond<T>(changes: ChangeSet, response: Result<T>): Write<T> {
	return { ...changes.result(), response };
}

const missing = { status: 404, error: "Not found" } satisfies Failure;
const busy = { status: 409, error: "This issue already has an active attempt" } satisfies Failure;
const settled = { status: 409, error: "This attempt has already ended" } satisfies Failure;

function issueOf(db: Db, key: string) {
	const separator = key.lastIndexOf("-");
	return findIssueRowByKey(db, key.slice(0, separator), Number(key.slice(separator + 1)));
}

function assignmentOf(issue: IssueRow) {
	return issue.fieldStamps.assigneeId?.version ?? 0;
}

function requestFor(db: Db, issue: IssueRow) {
	return db
		.select()
		.from(workRunRequests)
		.where(
			and(
				eq(workRunRequests.issueId, issue.id),
				eq(workRunRequests.assignmentVersion, assignmentOf(issue)),
			),
		)
		.get();
}

function publicRequest(db: Db, request: RequestRow) {
	const lastAttempt = request.lastAttemptId
		? db
				.select({ state: signals.state })
				.from(signals)
				.where(eq(signals.id, request.lastAttemptId))
				.get()
		: undefined;
	return {
		requestId: request.id,
		repository: request.repository,
		executor: request.executor,
		activeAttemptId: request.activeAttemptId,
		lastAttemptId: request.lastAttemptId,
		lastAttemptState: lastAttempt?.state ?? null,
	};
}
export type WorkRunRequestResult = Result<ReturnType<typeof publicRequest>>;

function reportingSource(db: Db, id: string, changes: ChangeSet) {
	const source = db.select().from(sources).where(eq(sources.id, id)).get();
	if (source?.product !== "agents" || source.paused || source.removing) return undefined;
	return liveConnectSeal(db, changes, id) ? undefined : source;
}

/**
 * An explicit workspace admin approval points one assignment at one runner, repository and
 * executor.
 */
export function registerWorkRun(
	db: Db,
	actor: string,
	input: RegisterWorkRunInput,
	now: number,
): Write<ReturnType<typeof publicRequest>> {
	const changes = new ChangeSet(db, actor, now);
	const member = activeMember(db, actor);
	if (!member || !isAdminRole(member.role)) {
		return respond(changes, { status: 403, error: "Only workspace admins can register work" });
	}
	const issue = issueOf(db, input.issue);
	const source = reportingSource(db, input.sourceId, changes);
	if (
		!issue?.assigneeId ||
		issue.intake ||
		issue.archivedAt !== null ||
		source?.teamId !== issue.teamId ||
		activeMember(db, issue.assigneeId)?.role !== "agent"
	) {
		return respond(changes, {
			status: 409,
			error: "Choose a live issue assigned to a runner and a reporting source for its team",
		});
	}
	const prior = requestFor(db, issue);
	if (prior) {
		if (
			prior.repository !== input.repository ||
			prior.sourceId !== source.id ||
			prior.executor !== input.executor
		) {
			return respond(changes, {
				status: 409,
				error: "This assignment already has a destination, repository and executor",
			});
		}
		return respond(changes, { status: 200, value: publicRequest(db, prior) });
	}
	const row = db
		.insert(workRunRequests)
		.values({
			id: crypto.randomUUID(),
			issueId: issue.id,
			assignmentVersion: assignmentOf(issue),
			runnerId: issue.assigneeId,
			repository: input.repository,
			sourceId: source.id,
			executor: input.executor,
		})
		.returning()
		.get();
	return respond(changes, { status: 201, value: publicRequest(db, row) });
}

export function findWorkRun(db: Db, actor: string, key: string): WorkRunRequestResult {
	const issue = issueOf(db, key);
	if (!issue || issue.assigneeId !== actor || issue.intake || issue.archivedAt !== null)
		return missing;
	if (activeMember(db, actor)?.role !== "agent") return missing;
	const request = requestFor(db, issue);
	if (!request || request.runnerId !== actor) return missing;
	return { status: 200, value: publicRequest(db, request) };
}

/**
 * The current assignment's approval, for an owner or admin's issue page. A reassigned issue has
 * none until an admin approves its new assignment.
 */
export function workRunApproval(db: Db, actor: string, key: string): WorkRunApprovalResult {
	const member = activeMember(db, actor);
	if (!member || !isAdminRole(member.role)) {
		return { status: 403, error: "Only workspace admins can see work approvals" };
	}
	const issue = issueOf(db, key);
	if (!issue || issue.intake || issue.archivedAt !== null) return missing;
	const request = requestFor(db, issue);
	if (!request) return missing;
	return { status: 200, value: { ...publicRequest(db, request), sourceId: request.sourceId } };
}
export type WorkRunApprovalResult = Result<ReturnType<typeof publicRequest> & { sourceId: string }>;

function sameHash(expected: string, supplied: string) {
	const encoder = new TextEncoder();
	const subtle = crypto.subtle;
	return (
		"timingSafeEqual" in subtle &&
		typeof subtle.timingSafeEqual === "function" &&
		subtle.timingSafeEqual(encoder.encode(expected), encoder.encode(supplied)) === true
	);
}

const unfinished = (state: SignalRow["state"]): state is "queued" | "running" =>
	(UNFINISHED_RUN_STATES as readonly string[]).includes(state);

/** Claiming, starting the visible signal, and reserving the issue commit together. */
export function claimWorkRun(
	db: Db,
	actor: string,
	input: ClaimWorkRunInput,
	tokenHash: string,
	now: number,
): Write<{
	attemptId: string;
	attemptNo: number;
	repository: string;
	active: boolean;
	canLaunch: boolean;
	linkOrigins: string[];
}> {
	const changes = new ChangeSet(db, actor, now);
	const runner = activeMember(db, actor);
	const request = db
		.select()
		.from(workRunRequests)
		.where(eq(workRunRequests.id, input.requestId))
		.get();
	if (runner?.role !== "agent" || request?.runnerId !== actor) return respond(changes, missing);
	// WEB-84 D5: a cloud run's work is never picked up by the local host, nor the other way round.
	if (request.executor !== input.executor) {
		return respond(changes, {
			status: 409,
			error:
				request.executor === "cloud"
					? "This work is registered for a cloud run"
					: "This work is registered for the local runner",
		});
	}
	const source = reportingSource(db, request.sourceId, changes);
	const issue = findIssueRowById(db, request.issueId);
	const eligible =
		issue?.assigneeId === actor &&
		!issue.intake &&
		issue.archivedAt === null &&
		assignmentOf(issue) === request.assignmentVersion &&
		source?.teamId === issue.teamId;

	const prior = db
		.select()
		.from(workRunAttempts)
		.where(
			and(eq(workRunAttempts.requestId, request.id), eq(workRunAttempts.claimId, input.claimId)),
		)
		.get();
	if (prior) {
		if (!sameHash(prior.tokenHash, tokenHash)) return respond(changes, missing);
		const signal = db
			.select({ state: signals.state })
			.from(signals)
			.where(eq(signals.id, prior.id))
			.get();
		const active = request.activeAttemptId === prior.id;
		return respond(changes, {
			status: 200,
			value: {
				attemptId: prior.id,
				attemptNo: prior.attemptNo,
				repository: request.repository,
				active,
				canLaunch: Boolean(eligible && active && signal?.state === "queued"),
				linkOrigins: source?.linkOrigins ?? [],
			},
		});
	}
	if (!eligible || !issue || !source) return respond(changes, missing);
	const active = db
		.select({ id: workRunRequests.id })
		.from(workRunRequests)
		.where(and(eq(workRunRequests.issueId, issue.id), isNotNull(workRunRequests.activeAttemptId)))
		.get();
	if (active) return respond(changes, busy);
	if (request.lastAttemptId !== (input.previousAttemptId ?? null)) {
		return respond(changes, {
			status: 409,
			error: "Reconcile the previous attempt before claiming again",
		});
	}
	const live =
		db
			.select({ n: count() })
			.from(signals)
			.where(and(eq(signals.sourceId, source.id), inArray(signals.state, UNFINISHED_RUN_STATES)))
			.get()?.n ?? 0;
	if (live >= LIVE_RUNS)
		return respond(changes, { status: 409, error: "This source has too many active runs" });

	const attemptId = crypto.randomUUID();
	const attemptNo = request.attempts + 1;
	const signal = db
		.insert(signals)
		.values({
			id: attemptId,
			sourceId: source.id,
			kind: "run",
			key: attemptId,
			severity: "unknown",
			state: "queued",
			issueId: issue.id,
			firstAt: now,
			changedAt: now,
			lastSentAt: now,
			executor: request.executor,
			agentName: runner.name.slice(0, 64).toWellFormed(),
			lastContactAt: now,
			attemptNo,
			repository: request.repository,
		})
		.returning()
		.get();
	db.insert(workRunAttempts)
		.values({ id: attemptId, requestId: request.id, claimId: input.claimId, tokenHash, attemptNo })
		.run();
	db.update(workRunRequests)
		.set({ activeAttemptId: attemptId, lastAttemptId: attemptId, attempts: attemptNo })
		.where(eq(workRunRequests.id, request.id))
		.run();
	changes.put("signal", toSignal(signal));
	return respond(changes, {
		status: 201,
		value: {
			attemptId,
			attemptNo,
			repository: request.repository,
			active: true,
			canLaunch: true,
			linkOrigins: source.linkOrigins,
		},
	});
}

/** A report can address only the existing attempt, by the reporter and the attempt token. */
export function reportWorkRun(
	db: Db,
	actor: string,
	input: ReportWorkRunInput,
	tokenHash: string,
	now: number,
): Write<{ state: RunState; sequence: number; applied: boolean }> {
	const changes = new ChangeSet(db, actor, now);
	const found = db
		.select({ attempt: workRunAttempts, request: workRunRequests, signal: signals })
		.from(workRunAttempts)
		.innerJoin(workRunRequests, eq(workRunRequests.id, workRunAttempts.requestId))
		.innerJoin(signals, eq(signals.id, workRunAttempts.id))
		.where(eq(workRunAttempts.id, input.attemptId))
		.get();
	if (
		!found ||
		found.request.runnerId !== actor ||
		activeMember(db, actor)?.role !== "agent" ||
		!sameHash(found.attempt.tokenHash, tokenHash)
	) {
		return respond(changes, missing);
	}
	const { attempt, request, signal } = found;
	const state = signal.state as RunState;
	if (input.sequence <= attempt.sequence) {
		return respond(changes, {
			status: 200,
			value: { state, sequence: attempt.sequence, applied: false },
		});
	}
	if (
		!unfinished(state) ||
		request.activeAttemptId !== attempt.id ||
		(state === "running" && input.state === "queued")
	) {
		return respond(changes, {
			status: 409,
			error: "This report cannot change the attempt's state",
		});
	}
	const source = reportingSource(db, request.sourceId, changes);
	if (!source) return respond(changes, missing);
	if (input.url && !source.linkOrigins.includes(new URL(input.url).origin)) {
		return respond(changes, {
			status: 400,
			error: "The link's origin is not approved for this reporting source",
		});
	}
	const closed = !unfinished(input.state);
	const row = db
		.update(signals)
		.set({
			state: input.state,
			changedAt: now,
			lastSentAt: now,
			lastContactAt: now,
			startedAt: signal.startedAt ?? (input.state === "running" ? now : null),
			endedAt: closed ? now : null,
			progress: input.progress ?? null,
			waitReason: input.waitReason ?? null,
			waitDetail: input.waitDetail ?? null,
			url: input.url ?? signal.url,
		})
		.where(eq(signals.id, attempt.id))
		.returning()
		.get();
	db.update(workRunAttempts)
		.set({ sequence: input.sequence })
		.where(eq(workRunAttempts.id, attempt.id))
		.run();
	if (closed)
		db.update(workRunRequests)
			.set({ activeAttemptId: null })
			.where(eq(workRunRequests.id, request.id))
			.run();
	changes.put("signal", toSignal(row));
	return {
		...respond(changes, {
			status: 200,
			value: { state: input.state, sequence: input.sequence, applied: true },
		}),
		wake: closed,
	};
}

/** An administrator can record an externally verified outcome, including after source removal. */
export function reconcileWorkRun(db: Db, actor: string, input: ReconcileWorkRunInput, now: number) {
	const changes = new ChangeSet(db, actor, now);
	const member = activeMember(db, actor);
	if (!member || !isAdminRole(member.role)) {
		return respond(changes, { status: 403, error: "Only workspace admins can reconcile work" });
	}
	const request = db
		.select({ id: workRunRequests.id })
		.from(workRunRequests)
		.where(eq(workRunRequests.activeAttemptId, input.attemptId))
		.get();
	if (!request) {
		// An attempt that has already ended keeps its outcome, as a report after the end does.
		const ended = db
			.select({ id: workRunAttempts.id })
			.from(workRunAttempts)
			.where(eq(workRunAttempts.id, input.attemptId))
			.get();
		return respond(changes, ended ? settled : missing);
	}
	db.update(workRunRequests)
		.set({ activeAttemptId: null })
		.where(eq(workRunRequests.id, request.id))
		.run();
	const row = db
		.update(signals)
		.set({
			state: input.state,
			changedAt: now,
			endedAt: now,
			progress: "Outcome confirmed by a workspace admin",
			waitReason: null,
			waitDetail: null,
		})
		.where(eq(signals.id, input.attemptId))
		.returning()
		.get();
	if (row) changes.put("signal", toSignal(row));
	return {
		...respond(changes, { status: 200, value: { attemptId: input.attemptId, state: input.state } }),
		wake: Boolean(row),
	};
}
