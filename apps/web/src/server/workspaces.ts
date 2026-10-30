import { env } from "cloudflare:workers";
import type { MemberRole, PersonRole } from "@gateweave/track-protocol";
import type { MemberProfile } from "@gateweave/track-sync-server";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { toPersonRole, toRole } from "./roles";

export interface Membership {
	workspaceId: string;
	workspaceName: string;
	profile: MemberProfile;
}

/** The Durable Object holding a workspace's data. Keyed by id so renaming the slug is free. */
export function workspaceStub(workspaceId: string) {
	return env.WORKSPACE.getByName(workspaceId);
}

/**
 * Deletes every file attached in a workspace. Its files share a prefix in the bucket, so they go
 * a page of keys at a time.
 */
export async function deleteWorkspaceFiles(workspaceId: string) {
	const bucket = env.FILES;
	if (!bucket) return;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: `${workspaceId}/`, cursor, limit: 1000 });
		if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Resolves a workspace slug to the caller's membership, or null if they are not a member. */
export async function findMembership(
	db: Database,
	slug: string,
	userId: string,
): Promise<Membership | null> {
	const row = await membershipQuery(db)
		.where(and(eq(schema.organization.slug, slug), eq(schema.member.userId, userId)))
		.get();
	return row
		? { workspaceId: row.workspaceId, workspaceName: row.workspaceName, profile: toProfile(row) }
		: null;
}

/** As `findMembership`, by the workspace's id, which links to attached files carry. */
export async function findMembershipById(
	db: Database,
	workspaceId: string,
	userId: string,
): Promise<Membership | null> {
	const row = await membershipQuery(db)
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)))
		.get();
	return row
		? { workspaceId: row.workspaceId, workspaceName: row.workspaceName, profile: toProfile(row) }
		: null;
}

export interface WorkspaceSummary {
	slug: string;
	name: string;
	role: MemberRole;
}

/** Every workspace the user belongs to, by name. */
export async function listWorkspaces(db: Database, userId: string): Promise<WorkspaceSummary[]> {
	const rows = await db
		.select({
			slug: schema.organization.slug,
			name: schema.organization.name,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(eq(schema.member.userId, userId))
		.orderBy(schema.organization.name)
		.all();
	return rows.map((row) => ({ ...row, role: toRole(row.role) }));
}

/** Pushes one user's current membership (or its absence) to the workspace's Durable Object. */
export async function syncMembership(db: Database, workspaceId: string, userId: string) {
	const row = await membershipQuery(db)
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)))
		.get();
	const stub = workspaceStub(workspaceId);
	if (row) await stub.syncMember(toProfile(row));
	else await stub.removeMember(userId);
}

/** Pushes a user's profile to every workspace they belong to. */
export async function syncUserEverywhere(db: Database, userId: string) {
	const rows = await membershipQuery(db).where(eq(schema.member.userId, userId)).all();
	await Promise.all(rows.map((row) => workspaceStub(row.workspaceId).syncMember(toProfile(row))));
}

export interface InvitationPreview {
	workspaceName: string;
	workspaceSlug: string;
	inviterName: string;
	email: string;
	role: PersonRole;
	expiresAt: number;
}

/**
 * A pending, unexpired invitation, with what its recipient needs to decide before signing in.
 * The id is the secret here, just as it is in the invitation link.
 */
export async function findPendingInvitation(
	db: Database,
	invitationId: string,
): Promise<InvitationPreview | null> {
	const row = await db
		.select({
			workspaceName: schema.organization.name,
			workspaceSlug: schema.organization.slug,
			inviterName: schema.user.name,
			email: schema.invitation.email,
			role: schema.invitation.role,
			expiresAt: schema.invitation.expiresAt,
		})
		.from(schema.invitation)
		.innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
		.innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
		.where(
			and(
				eq(schema.invitation.id, invitationId),
				eq(schema.invitation.status, "pending"),
				gt(schema.invitation.expiresAt, new Date()),
			),
		)
		.get();
	return row
		? { ...row, role: toPersonRole(row.role ?? "member"), expiresAt: row.expiresAt.getTime() }
		: null;
}

function membershipQuery(db: Database) {
	return db
		.select({
			workspaceId: schema.member.organizationId,
			workspaceName: schema.organization.name,
			role: schema.member.role,
			userId: schema.user.id,
			name: schema.user.name,
			email: schema.user.email,
			image: schema.user.image,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id));
}

function toProfile(row: {
	role: string;
	userId: string;
	name: string;
	email: string;
	image: string | null;
}): MemberProfile {
	return {
		id: row.userId,
		name: row.name,
		email: row.email,
		image: row.image,
		role: toRole(row.role),
	};
}
