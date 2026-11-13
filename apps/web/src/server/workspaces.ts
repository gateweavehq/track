import { env } from "cloudflare:workers";
import type { GatewayAuditEvent, MemberRole, PersonRole } from "@gateweave/track-protocol";
import type { MemberProfile } from "@gateweave/track-sync-server";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { configuredJurisdiction, objectsIn } from "./jurisdiction";
import { toPersonRole, toRole } from "./roles";

/**
 * A workspace, and the jurisdiction its Durable Object is in, null for none ("Where a workspace
 * lives" in docs/architecture.md). The same name in another jurisdiction is another object, so
 * reaching a workspace takes both.
 */
export interface WorkspaceRef {
	workspaceId: string;
	jurisdiction: string | null;
}

export interface Membership extends WorkspaceRef {
	workspaceName: string;
	profile: MemberProfile;
}

/** The Durable Object holding a workspace's data. Keyed by id so renaming the slug is free. */
export function workspaceStub({ workspaceId, jurisdiction }: WorkspaceRef) {
	return objectsIn(env.WORKSPACE, jurisdiction).getByName(workspaceId);
}

/** Where a workspace's object is, for a workspace known by its id alone. */
export async function findWorkspaceRef(db: Database, workspaceId: string): Promise<WorkspaceRef> {
	const row = await db
		.select({ jurisdiction: schema.workspaceLocation.jurisdiction })
		.from(schema.workspaceLocation)
		.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
		.get();
	return { workspaceId, jurisdiction: row?.jurisdiction ?? null };
}

/** As `workspaceStub`, for a workspace known by its id alone. */
export async function findWorkspaceStub(db: Database, workspaceId: string) {
	return workspaceStub(await findWorkspaceRef(db, workspaceId));
}

/**
 * Notes where a new workspace's object goes: in the deployment's jurisdiction, if it has one.
 * Before anything reaches the object, which reaching it makes. If this fails, the object is made
 * outside any, and the daily run moves it.
 */
export async function placeNewWorkspace(db: Database, workspaceId: string): Promise<void> {
	const jurisdiction = configuredJurisdiction();
	if (!jurisdiction) return;
	await db
		.insert(schema.workspaceLocation)
		.values({ workspaceId, jurisdiction })
		.onConflictDoNothing()
		.run();
}

/**
 * Permanently deletes a deleted workspace's data: its object, and the sealed one it moved from,
 * if that is still there. Then forgets where they were.
 */
export async function destroyWorkspace(db: Database, workspaceId: string): Promise<void> {
	const location = await db
		.select()
		.from(schema.workspaceLocation)
		.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
		.get();
	await workspaceStub({ workspaceId, jurisdiction: location?.jurisdiction ?? null }).destroy();
	if (location?.movedFrom != null) {
		await objectsIn(env.WORKSPACE, location.movedFrom).getByName(workspaceId).destroy();
	}
	if (location) {
		await db
			.delete(schema.workspaceLocation)
			.where(eq(schema.workspaceLocation.workspaceId, workspaceId))
			.run();
	}
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
	return row ? toMembership(row) : null;
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
	return row ? toMembership(row) : null;
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
	const stub = row ? workspaceStub(row) : await findWorkspaceStub(db, workspaceId);
	if (row) await stub.syncMember(toProfile(row));
	else await stub.removeMember(userId);
}

/** Tells a workspace of a change made in D1, for its audit log. */
export async function reportAudit(db: Database, workspaceId: string, event: GatewayAuditEvent) {
	if (!(await (await findWorkspaceStub(db, workspaceId)).audit(event))) {
		console.error(`audit: the workspace refused a ${event.action} event`);
	}
}

/** Pushes a user's profile to every workspace they belong to. */
export async function syncUserEverywhere(db: Database, userId: string) {
	const rows = await membershipQuery(db).where(eq(schema.member.userId, userId)).all();
	await Promise.all(rows.map((row) => workspaceStub(row).syncMember(toProfile(row))));
}

/** Closes the user's sync sockets opened with any of these sessions, in every workspace. */
export async function endSessionsEverywhere(db: Database, userId: string, sessionIds: string[]) {
	const rows = await db
		.select({
			workspaceId: schema.member.organizationId,
			jurisdiction: schema.workspaceLocation.jurisdiction,
		})
		.from(schema.member)
		.leftJoin(
			schema.workspaceLocation,
			eq(schema.workspaceLocation.workspaceId, schema.member.organizationId),
		)
		.where(eq(schema.member.userId, userId))
		.all();
	await Promise.all(rows.map((row) => workspaceStub(row).endSessions(userId, sessionIds)));
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
			jurisdiction: schema.workspaceLocation.jurisdiction,
			workspaceName: schema.organization.name,
			role: schema.member.role,
			userId: schema.user.id,
			name: schema.user.name,
			email: schema.user.email,
			image: schema.user.image,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.leftJoin(
			schema.workspaceLocation,
			eq(schema.workspaceLocation.workspaceId, schema.member.organizationId),
		);
}

function toMembership(
	row: WorkspaceRef & {
		workspaceName: string;
		role: string;
		userId: string;
		name: string;
		email: string;
		image: string | null;
	},
): Membership {
	return {
		workspaceId: row.workspaceId,
		jurisdiction: row.jurisdiction,
		workspaceName: row.workspaceName,
		profile: toProfile(row),
	};
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
