import { isAdminRole, SYSTEM_ACTOR_ID } from "@gateweave/track-protocol";
import { and, count, eq, isNull, lte, min, sql } from "drizzle-orm";
import { z } from "zod";
import { comments, issues, type MemberRow, members, panelSeats, panels } from "./db/schema";
import { notify } from "./inbox";
import { ChangeSet } from "./log";
import { findIssueRowById } from "./queries";
import { MutationRejected } from "./rejected";
import { indexComment } from "./search";
import { activeMember, type Db, toComment } from "./state";
import { queueDeliveries } from "./webhooks";

export const MAX_OPEN_PANELS = 3;
export const MAX_PANEL_SEATS = 5;
export const MAX_POSITION_CHARS = 20_000;
export const MAX_PANEL_DAYS = 30;
export const openPanelInput = z.strictObject({
	issueId: z.string().min(1),
	seats: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_PANEL_SEATS)
		.refine((ids) => new Set(ids).size === ids.length, "Seats must be unique"),
	deadlineAt: z.number().int(),
});
export const getPanelInput = z.strictObject({ panelId: z.string().min(1) });
export const submitPositionInput = getPanelInput.extend({
	body: z.string().trim().min(1).max(MAX_POSITION_CHARS),
});
export type OpenPanelInput = z.infer<typeof openPanelInput>;
export type SubmitPositionInput = z.infer<typeof submitPositionInput>;
export type GetPanelInput = z.infer<typeof getPanelInput>;
type Panel = typeof panels.$inferSelect;
export interface PanelView extends Panel {
	/** A deleted issue still has a key, even though the ordinary issue read omits it. */
	issueRef: { teamId: string; number: number };
	seats: { memberId: string; submitted: boolean }[];
	own: string | null;
	positions: { alias: string; body: string }[] | null;
	absent: string[] | null;
}

/** A uniform integer below `n`: draws above the largest whole multiple of `n` are redrawn. */
export function randomBelow(n: number) {
	const limit = 2 ** 32 - (2 ** 32 % n);
	for (;;) {
		const r = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit;
		if (r < limit) return r % n;
	}
}

function memberName(db: Db, userId: string) {
	return (
		db.select({ name: members.name }).from(members).where(eq(members.userId, userId)).get()?.name ??
		"Deleted member"
	);
}

/** A Track-authored comment on the panel's issue, in the change set's batch. */
function postComment(db: Db, changes: ChangeSet, issueId: string, id: string, body: string) {
	const row = {
		id,
		issueId,
		authorId: SYSTEM_ACTOR_ID,
		body,
		createdAt: changes.now,
		updatedAt: changes.now,
		deletedAt: null,
	};
	db.insert(comments).values(row).run();
	indexComment(db, row);
	changes.put("comment", toComment(row));
	changes.events.push({ type: "comment.created", comment: row });
}

function readPanel(db: Db, id: string) {
	const panel = db.select().from(panels).where(eq(panels.id, id)).get();
	if (!panel) throw new MutationRejected("not_found", "Panel not found");
	return panel;
}

function seatsOf(db: Db, id: string) {
	return db.select().from(panelSeats).where(eq(panelSeats.panelId, id)).orderBy(sql`rowid`).all();
}

export function getPanel(db: Db, member: MemberRow, { panelId }: GetPanelInput): PanelView {
	const panel = readPanel(db, panelId);
	const seats = seatsOf(db, panelId);
	const caller = seats.find((s) => s.memberId === member.userId);
	const open = panel.state === "open";
	if (open && !caller && !isAdminRole(member.role))
		throw new MutationRejected("not_found", "Panel not found");
	const issueRef = db
		.select({ teamId: issues.teamId, number: issues.number })
		.from(issues)
		.where(eq(issues.id, panel.issueId))
		.get();
	if (!issueRef) throw new Error("Missing panel issue");
	return {
		...panel,
		issueRef,
		seats: seats.map((s) => ({ memberId: s.memberId, submitted: s.body !== null })),
		own: open ? (caller?.body ?? null) : null,
		positions: open
			? null
			: seats
					.flatMap((s) =>
						s.alias !== null && s.body !== null ? [{ alias: s.alias, body: s.body }] : [],
					)
					.sort((a, b) => a.alias.localeCompare(b.alias)),
		absent: open ? null : seats.filter((s) => s.body === null).map((s) => s.memberId),
	};
}

export function openPanel(db: Db, member: MemberRow, input: OpenPanelInput, now: number) {
	if (!isAdminRole(member.role))
		throw new MutationRejected("forbidden", "Only owners and admins can open panels");
	if (findIssueRowById(db, input.issueId)?.archivedAt !== null)
		throw new MutationRejected("not_found", "Issue not found");
	if (input.deadlineAt <= now || input.deadlineAt > now + MAX_PANEL_DAYS * 86_400_000)
		throw new MutationRejected("invalid", "Deadline must be in the next 30 days");
	if (input.seats.some((id) => !activeMember(db, id)))
		throw new MutationRejected("invalid", "Every seat must be an active workspace member");
	const total = db.select({ n: count() }).from(panels).where(eq(panels.state, "open")).get();
	if (total && total.n >= MAX_OPEN_PANELS)
		throw new MutationRejected("conflict", "Three panels are already open");
	const id = crypto.randomUUID().replaceAll("-", "");
	db.insert(panels)
		.values({
			id,
			issueId: input.issueId,
			deadlineAt: input.deadlineAt,
			openedAt: now,
			openedBy: member.userId,
		})
		.run();
	db.insert(panelSeats)
		.values(input.seats.map((memberId) => ({ panelId: id, memberId })))
		.run();
	// Seats learn the panel id from this comment; it holds no position text.
	const changes = new ChangeSet(db, SYSTEM_ACTOR_ID, now);
	postComment(
		db,
		changes,
		input.issueId,
		crypto.randomUUID(),
		`Panel opened (id \`${id}\`). Seats: ${input.seats.map((s) => memberName(db, s)).join(", ")}. Deadline: ${new Date(input.deadlineAt).toISOString()}. Each seat submits one position with \`submit_position\`; all positions are revealed together under aliases when the last one is in or the deadline passes.`,
	);
	return {
		...publish(db, changes),
		wake: true,
		response: getPanel(db, member, { panelId: id }),
	};
}

export function submitPosition(db: Db, member: MemberRow, input: SubmitPositionInput, now: number) {
	const panel = readPanel(db, input.panelId);
	const seatKey = and(eq(panelSeats.panelId, panel.id), eq(panelSeats.memberId, member.userId));
	if (!db.select({ id: panelSeats.memberId }).from(panelSeats).where(seatKey).get())
		throw new MutationRejected("not_found", "Panel not found");
	if (panel.state !== "open" || now >= panel.deadlineAt)
		throw new MutationRejected("conflict", "The panel is closed");
	const submitted = db
		.update(panelSeats)
		.set({ body: input.body, submittedAt: now })
		.where(and(seatKey, isNull(panelSeats.body)))
		.returning({ id: panelSeats.memberId })
		.get();
	if (!submitted) throw new MutationRejected("conflict", "You have already submitted a position");
	const changes = new ChangeSet(db, SYSTEM_ACTOR_ID, now);
	const complete = seatsOf(db, panel.id).every((s) => s.body !== null);
	if (complete) revealPanel(db, changes, panel, "complete", now);
	return {
		...(complete ? publish(db, changes) : changes.result()),
		response: getPanel(db, member, input),
	};
}

export function revealPanel(
	db: Db,
	changes: ChangeSet,
	panel: Panel,
	reason: NonNullable<Panel["revealReason"]>,
	now: number,
) {
	const claimed = db
		.update(panels)
		.set({ state: "revealed", revealedAt: now, revealReason: reason })
		.where(and(eq(panels.id, panel.id), eq(panels.state, "open")))
		.returning({ id: panels.id })
		.get();
	if (!claimed) return;
	const seats = seatsOf(db, panel.id);
	const submitted = seats.flatMap((s) =>
		s.body === null ? [] : [{ memberId: s.memberId, body: s.body }],
	);
	for (let i = submitted.length - 1; i > 0; i--) {
		const j = randomBelow(i + 1);
		const a = submitted[i];
		const b = submitted[j];
		if (a && b) {
			submitted[i] = b;
			submitted[j] = a;
		}
	}
	const absent = seats.filter((s) => s.body === null).map((s) => memberName(db, s.memberId));
	const bodies = [
		`Panel revealed: ${submitted.length} of ${seats.length} seats submitted (${reason === "complete" ? "all in" : "deadline passed"}). Absent: ${absent.join(", ") || "none"}.`,
	];
	for (const [index, seat] of submitted.entries()) {
		const alias = `Position ${String.fromCharCode(65 + index)}`;
		db.update(panelSeats)
			.set({ alias })
			.where(and(eq(panelSeats.panelId, panel.id), eq(panelSeats.memberId, seat.memberId)))
			.run();
		bodies.push(`**${alias}**\n\n${seat.body}`);
	}
	if (findIssueRowById(db, panel.issueId)?.archivedAt !== null) return;
	// Comments sort by creation time, then id. Keep this batch in its publication order.
	const prefix = crypto.randomUUID();
	for (const [index, body] of bodies.entries())
		postComment(db, changes, panel.issueId, `${prefix}-${index}`, body);
}

function publish(db: Db, changes: ChangeSet) {
	const wake = notify(db, changes, SYSTEM_ACTOR_ID, false);
	const result = changes.result();
	return {
		...result,
		wake,
		queued: queueDeliveries(db, null, changes.events, result.version, changes.now),
	};
}

export function revealDuePanels(db: Db, now: number) {
	const changes = new ChangeSet(db, SYSTEM_ACTOR_ID, now);
	const due = db
		.select()
		.from(panels)
		.where(and(eq(panels.state, "open"), lte(panels.deadlineAt, now)))
		.all();
	for (const panel of due) revealPanel(db, changes, panel, "deadline", now);
	return publish(db, changes);
}

export function nextPanelDeadline(db: Db) {
	return (
		db
			.select({ at: min(panels.deadlineAt) })
			.from(panels)
			.where(eq(panels.state, "open"))
			.get()?.at ?? null
	);
}
