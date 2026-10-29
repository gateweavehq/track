/**
 * Agents' proposals (see `Proposal` in the protocol). An agent member's issue mutation is split by
 * its `proposes`: what that covers waits on the issue as proposals, and the rest applies as usual.
 * Accepting one is the person making the change, in `mutations.ts`.
 */
import { CLOSED_STATUSES, type Proposal, type ProposedChange } from "@gateweave/track-protocol";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "./db/schema";
import type { ChangeSet } from "./log";
import { type Db, toProposal } from "./state";

/** Whether this change, made by this member, is one to propose rather than make. */
export function proposesChange(member: schema.MemberRow, change: ProposedChange): boolean {
	if (member.role !== "agent") return false;
	const kinds = member.proposes;
	switch (change.type) {
		case "status":
			return (
				kinds.includes("status") || (kinds.includes("close") && CLOSED_STATUSES.includes(change.to))
			);
		case "label":
			return kinds.includes("labels");
		default:
			return kinds.includes(change.type);
	}
}

/**
 * Records an agent's proposal on a live issue, in place of its open one for the same field. A
 * proposal of what the issue already has withdraws that one instead, since the agent's latest
 * word is that nothing needs to change.
 */
export function propose(
	db: Db,
	changes: ChangeSet,
	issue: schema.IssueRow,
	agentId: string,
	change: ProposedChange,
): void {
	const existing = openProposals(db, issue.id).find(
		(proposal) => proposal.agentId === agentId && sameField(proposal.change, change),
	);
	if (alreadyMade(issue, change)) {
		if (existing) decide(db, changes, existing, "dismissed", agentId);
		return;
	}
	if (existing) {
		if (!sameChange(existing.change, change)) {
			const row = db
				.update(schema.proposals)
				.set({ change, updatedAt: changes.now })
				.where(eq(schema.proposals.id, existing.id))
				.returning()
				.get();
			if (row) {
				changes.put("proposal", toProposal(row));
				changes.events.push({ type: "proposal.updated", proposal: row });
			}
		}
		changes.proposed.push(toProposal({ ...existing, change }));
		return;
	}
	const row: schema.ProposalRow = {
		id: crypto.randomUUID(),
		issueId: issue.id,
		agentId,
		change,
		status: "open",
		decidedBy: null,
		decidedAt: null,
		createdAt: changes.now,
		updatedAt: changes.now,
	};
	db.insert(schema.proposals).values(row).run();
	changes.put("proposal", toProposal(row));
	changes.events.push({ type: "proposal.created", proposal: row });
	changes.proposed.push(toProposal(row));
}

/** Closes a proposal as accepted or dismissed. Its row stays, as the record of who decided. */
export function decide(
	db: Db,
	changes: ChangeSet,
	proposal: schema.ProposalRow,
	status: "accepted" | "dismissed",
	by: string,
): void {
	const row = db
		.update(schema.proposals)
		.set({ status, decidedBy: by, decidedAt: changes.now, updatedAt: changes.now })
		.where(eq(schema.proposals.id, proposal.id))
		.returning()
		.get();
	changes.delete("proposal", proposal.id);
	if (row) changes.events.push({ type: `proposal.${status}`, proposal: row });
}

/** An issue's open proposals, oldest first. */
export function openProposals(db: Db, issueId: string): schema.ProposalRow[] {
	return db
		.select()
		.from(schema.proposals)
		.where(and(eq(schema.proposals.issueId, issueId), eq(schema.proposals.status, "open")))
		.orderBy(asc(schema.proposals.createdAt), asc(schema.proposals.id))
		.all();
}

/** An open proposal of a live issue: one a person can still decide on. */
export function findOpenProposal(db: Db, id: string): schema.ProposalRow | undefined {
	const row = db
		.select({ proposal: schema.proposals, deletedAt: schema.issues.deletedAt })
		.from(schema.proposals)
		.innerJoin(schema.issues, eq(schema.issues.id, schema.proposals.issueId))
		.where(and(eq(schema.proposals.id, id), eq(schema.proposals.status, "open")))
		.get();
	return row && row.deletedAt === null ? row.proposal : undefined;
}

/** A live issue's open proposals, as clients see them. */
export function issueProposals(db: Db, issueId: string): Proposal[] {
	return openProposals(db, issueId).map(toProposal);
}

/** The field of the issue a proposal would write, as an `issue.update` patch. */
export function patchOf(change: Exclude<ProposedChange, { type: "label" }>) {
	switch (change.type) {
		case "title":
			return { title: change.to };
		case "description":
			return { description: change.to };
		case "status":
			return { status: change.to };
		case "priority":
			return { priority: change.to };
		case "assignee":
			return { assigneeId: change.to };
		case "project":
			return { projectId: change.to };
	}
}

function alreadyMade(issue: schema.IssueRow, change: ProposedChange): boolean {
	switch (change.type) {
		case "title":
			return issue.title === change.to;
		case "description":
			return issue.description === change.to;
		case "status":
			return issue.status === change.to;
		case "priority":
			return issue.priority === change.to;
		case "assignee":
			return issue.assigneeId === change.to;
		case "project":
			return issue.projectId === change.to;
		case "label":
			return issue.labelIds.includes(change.labelId) === change.added;
	}
}

/** Labels are proposed one by one, so each label is a field of its own. */
function sameField(a: ProposedChange, b: ProposedChange): boolean {
	if (a.type === "label" && b.type === "label") return a.labelId === b.labelId;
	return a.type === b.type;
}

function sameChange(a: ProposedChange, b: ProposedChange): boolean {
	if (a.type === "label" && b.type === "label") {
		return a.labelId === b.labelId && a.added === b.added;
	}
	if (a.type === "label" || b.type === "label") return false;
	return a.type === b.type && a.to === b.to;
}
