import { env } from "cloudflare:workers";
import { isAdminRole, type SourceProduct, type SourceThreshold } from "@gateweave/track-protocol";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type ConnectPurpose,
	checkConnectRequest,
	checkSourceConnectRequest,
	MAX_AGENT_NAME_LENGTH,
	parseConnectOrigins,
	returnAddress,
} from "../lib/connect-request";
import { appOrigin, db, getAuth } from "./auth";
import { removeAgentOf } from "./auth/agents";
import { countedByWhoSentIt } from "./auth/workers-address";
import { readText } from "./body";
import { schema } from "./db";
import { CONNECT_PREFIX } from "./db/prune";
import { demoEnabled } from "./demo/mode";
import { allowConnectApproval, limitConnectCalls } from "./rate-limit";
import { makeSourceKey, newSourceKey, removeSourceKeys, sourceKeys } from "./source-keys";
import { webhooksEnabled } from "./webhooks";
import {
	findMembership,
	findWorkspaceStub,
	listWorkspaces,
	reportAudit,
	syncMembership,
	workspaceStub,
} from "./workspaces";

/**
 * Connecting an agent in one step ("Connecting an agent in one step" in docs/architecture.md): an
 * admin's browser comes here from another server, the admin approves, and Track makes an agent
 * member and a webhook for it. The other server then fetches the two secrets with a one-time code,
 * from its own server, with the verifier only it holds.
 *
 *   /connect/agent                 the page, with `getConnectOffer` and `approveAgentConnection`
 *                                  (lib/connect.ts) behind it: a session, an admin
 *   POST /api/connect/exchange     a server trades a code and its verifier for the secrets
 *   POST /api/connect/undo         a server takes back what a connection made, with a signed token
 *
 * The two POST routes take no session: the code (32 random bytes, kept for a minute, used once)
 * and the verifier are what admit the first, and the token Track signed the second. Cookies are
 * never read.
 */

const CODE_TTL_MS = 60 * 1000;
/** Retain the D1 expiry margin for older Workers that still prune on verification lookup. */
const ROW_KEPT_MS = 3 * 24 * 60 * 60 * 1000;
/** A take-back that failed is tried again this much later, at most this many times. */
const TAKE_BACK_AGAIN_MS = 60 * 60 * 1000;
const TAKE_BACK_TRIES = 3;
const CLAIM_MS = 10 * 60_000;
const PENDING_GRACE_MS = 60 * 60_000;
const SOURCE_UNDO_SECONDS = 3 * 86400;
const UNDO_TTL_SECONDS = 10 * 60;
/** The purposes the secret is used under, each its own key, and part of what a seal binds to. */
const SEAL_PURPOSE = "track-connect-code-v1";
const UNDO_PURPOSE = "track-connect-undo-v1";
const SOURCE_UNDO_PURPOSE = "track-connect-source-undo-v1";
const CODE = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[\w-]{1,64}$/;
const MAX_BODY_BYTES = 4096;
/** How many codes past their minute an approval clears, so Allow stays fast. */
const SWEEP_ON_APPROVAL = 5;
/** What one daily run clears, in rounds, so a backlog never holds the run up for long. */
const SWEEP_ROUND = 25;
const SWEEP_ROUNDS = 8;

export function isConnectRequest(url: URL): boolean {
	return url.pathname === "/api/connect/exchange" || url.pathname === "/api/connect/undo";
}

/** The answer to every code that does not open: wrong, used, late, or without its verifier. */
const NO_CODE = { error: "invalid_code" } as const;
const NO_UNDO = { error: "invalid_undo" } as const;

/** Answers `POST /api/connect/exchange` and `POST /api/connect/undo`. */
export async function handleConnectRequest(request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (request.method !== "POST") {
		return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
	}
	// Counted first, by who sent it: a server calling from a Worker is the zone it runs on.
	const counted = await countedByWhoSentIt(request);
	const { allowed, retryAfter } = await limitConnectCalls(
		counted.headers.get("cf-connecting-ip") ?? "unknown",
	);
	if (!allowed) {
		return json({ error: "too_many_requests" }, 429, { "retry-after": String(retryAfter ?? 60) });
	}

	// From the request as counted: making it moved the body there.
	const text = await readText(counted, MAX_BODY_BYTES);
	let body: unknown = null;
	try {
		body = text === null ? null : JSON.parse(text);
	} catch {
		// Answered below, as any other request that opens nothing.
	}
	return path === "/api/connect/exchange" ? exchange(body) : undo(body);
}

const exchangeBody = z.object({
	code: z.string().regex(CODE),
	// As PKCE has it. A body that is not shaped like one opens nothing and spends nothing.
	verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});

/** What the code's row seals: the secrets, and what the exchange answers besides them. */
type Sealed = AgentSealed | SourceSealed;

interface AgentSealed {
	kind?: "agent";
	agentKey: string;
	webhookSecret: string;
	agent: { id: string; memberId: string; name: string };
	workspace: { id: string; slug: string; name: string };
	webhook: { id: string };
	undo: string;
	returnOrigin: string;
}

interface SourceSealed {
	kind: "source";
	sourceKey: string;
	endpoint: string;
	source: { id: string; name: string; product: SourceProduct };
	workspace: AgentSealed["workspace"];
	team: { id: string; key: string; name: string };
	undo: string;
	undoUntil: string;
}

/** What the row keeps in `value`: the challenge in the clear, the rest sealed under the code. */
const stored = z.object({
	v: z.literal(1),
	kind: z.enum(["agent", "source"]).default("agent"),
	state: z.literal("ready").optional(),
	challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	iv: z.string(),
	ct: z.string(),
});

/**
 * What a row says in the clear about what it was made for, so that a code that is refused or never
 * traded can be taken back without opening the seal. These are ids, not secrets. A row written
 * before they were kept (v0.39.0) has none, and there is nothing to take back for it.
 */
const madeBase = z.object({
	workspaceId: z.string().regex(ID),
	origin: z.string().max(2048).optional(),
	tries: z.number().int().min(0).max(TAKE_BACK_TRIES).optional(),
});
const madeFor = z.union([
	madeBase.extend({
		kind: z.literal("agent").default("agent"),
		agentId: z.string().regex(ID),
		keyId: z.string().regex(ID).optional(),
	}),
	madeBase.extend({
		kind: z.literal("source"),
		state: z.enum(["pending", "ready", "undo"]),
		sourceId: z.string().regex(ID),
		keyId: z.string().regex(ID),
	}),
]);
type MadeFor = z.infer<typeof madeFor>;

function readMadeFor(value: string): MadeFor | null {
	try {
		const read = madeFor.safeParse(JSON.parse(value));
		return read.success ? read.data : null;
	} catch {
		return null;
	}
}

function existingWorkspace(workspaceId: string) {
	return db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
}

/** A claim guards cleanup of an untraded code. A signed agent undo has no claim. */
async function takeBack(
	workspaceId: string,
	agentId: string,
	detail: Record<string, string> = {},
	condition?: SQL,
) {
	// The workspace must still exist in D1 before its object is reached, which reaching it makes.
	const workspace = await existingWorkspace(workspaceId);
	if (!workspace) return;
	const stub = await findWorkspaceStub(db, workspaceId);
	// Signed undo removes the webhooks first. Claimed cleanup must win the D1 delete first.
	if (!condition) await stub.removeConnectedWebhooksOf(agentId);
	const removed = await removeAgentOf(db, workspaceId, agentId, condition);
	if (removed === null && condition) {
		// A surviving user means the claim or the keys changed. A missing user means a retry
		// still owes the object both calls after a previous D1 delete.
		const present = await db
			.select({ id: schema.user.id })
			.from(schema.user)
			.where(eq(schema.user.id, agentId))
			.get();
		if (present) return;
	}
	await syncMembership(db, workspaceId, agentId);
	if (condition) await stub.removeConnectedWebhooksOf(agentId);
	if (removed !== null) {
		await reportAudit(db, workspaceId, {
			actorId: null,
			action: "agent.deleted",
			target: { type: "agent", id: agentId, label: null },
			detail,
		});
	}
}

/**
 * When a row's code stops being good, in milliseconds: `goodUntil` in the row, or for a row
 * written before that was kept (v0.39.0), its `expiresAt`.
 */
function goodUntilOf(row: { value: string; expiresAt: Date }): number {
	try {
		const { goodUntil } = JSON.parse(row.value) as { goodUntil?: unknown };
		if (typeof goodUntil === "number") return goodUntil;
	} catch {
		// Not a row this wrote: its own time stands.
	}
	return row.expiresAt.getTime();
}

type CodeRow = Pick<typeof schema.verification.$inferSelect, "id" | "value">;

const verification = schema.verification;
const sameRow = (row: CodeRow) =>
	and(eq(verification.id, row.id), eq(verification.value, row.value));
const holds = (row: CodeRow) => sql`exists (select 1 from ${verification} where ${sameRow(row)})`;
const stillHeld = (row: CodeRow) =>
	db.select({ id: verification.id }).from(verification).where(sameRow(row)).get();

async function takeBackSource(
	row: CodeRow,
	made: Extract<MadeFor, { kind: "source" }>,
	reason: string,
) {
	const { workspaceId, sourceId, keyId, state } = made;
	const workspace = await existingWorkspace(workspaceId);
	if (!workspace) return "kept";
	if (!(await stillHeld(row))) return "retry";
	const stub = await findWorkspaceStub(db, workspaceId);
	const { claimNonce, allowNonce, sweepAt } = JSON.parse(row.value);
	const holder = `${keyId}:${claimNonce ?? allowNonce}`;
	const askedAt = Date.now();
	const status = await stub.removeConnectedSource(sourceId, holder);
	if (status === "busy") return "retry";
	const deleteKey = async () => {
		const deleted = await removeSourceKeys(db, workspaceId, sourceId, keyId, holds(row));
		// Zero also means an earlier attempt deleted the key before it lost its reply.
		return deleted.meta.changes === 1 || Boolean(await stillHeld(row));
	};
	if (status === "gone") {
		if (!(await deleteKey())) return "retry";
		return state === "pending" && askedAt < sweepAt + PENDING_GRACE_MS ? "withinGrace" : "gone";
	}
	if (status !== "sealed") return status;
	const keys = await sourceKeys(db, workspaceId, sourceId);
	const lost = async () => {
		await stub.releaseConnectedSource(sourceId, holder);
		return "retry" as const;
	};
	if (!(await stillHeld(row))) return lost();
	if (!keys.every((key) => key.id === keyId) || (state !== "pending" && keys.length !== 1)) {
		await stub.releaseConnectedSource(sourceId, holder);
		return "kept";
	}
	if (state === "pending" && !(await deleteKey())) return lost();
	const removed = await stub.finishConnectedSourceRemoval(sourceId, holder, reason);
	// A competing finish can leave its key behind if it has since lost its D1 claim.
	if (!removed) {
		if (!(await stillHeld(row))) return lost();
		throw new Error("Source removal must be checked again");
	}
	if (state !== "pending" && !(await deleteKey())) return "retry";
	return status;
}

async function cleanClaim(row: CodeRow, reason: string) {
	const made = readMadeFor(row.value);
	try {
		if (made?.kind === "source") {
			const status = await takeBackSource(row, made, made.state === "undo" ? "undo" : reason);
			if (status === "retry") return;
			if (status === "withinGrace") {
				await db
					.update(verification)
					.set({
						value: sql`json_remove(${verification.value}, '$.claimedUntil', '$.claimNonce')`,
						updatedAt: new Date(),
					})
					.where(sameRow(row))
					.run();
				return;
			}
		} else if (made) {
			await takeBackAgent(row, made, reason);
		}
		await db.delete(verification).where(sameRow(row)).run();
	} catch (error) {
		console.error("connect: could not take back a connection whose code was not used", error);
		if (!made || made.kind === "source") return; // The claim expires and the sweep retries.
		const tries = (made.tries ?? 0) + 1;
		if (tries >= TAKE_BACK_TRIES) {
			await db.delete(verification).where(sameRow(row)).run();
			return;
		}
		await db
			.update(verification)
			.set({
				identifier: `${CONNECT_PREFIX}retry.${crypto.randomUUID()}`,
				value: JSON.stringify({
					...made,
					tries,
					goodUntil: 0,
					sweepAt: Date.now() + TAKE_BACK_AGAIN_MS,
				}),
				expiresAt: new Date(Date.now() + ROW_KEPT_MS),
			})
			.where(sameRow(row))
			.run();
	}
}

async function takeBackAgent(
	row: CodeRow,
	made: Extract<MadeFor, { kind: "agent" }>,
	reason: string,
) {
	const { agentKey } = schema;
	// Historical approvals did not record the key id. They still require one unused key.
	const untouched = sql`(select count(*) = 1 and count(${agentKey.lastUsedAt}) = 0
		${made.keyId === undefined ? sql.empty() : sql`and max(${agentKey.id}) = ${made.keyId}`}
		from ${agentKey} where ${agentKey.userId} = ${made.agentId}
		and ${agentKey.organizationId} = ${made.workspaceId})`;
	await takeBack(
		made.workspaceId,
		made.agentId,
		{
			reason,
			...(made.origin && { origin: made.origin }),
		},
		and(holds(row), untouched),
	);
}

/** A lease survives a Worker restart. Its exact row value fences completion by an older worker. */
export async function sweepConnections(max: number): Promise<number> {
	try {
		// Older agent rows have no sweepAt. Their verification expiry is their deadline.
		const now = Date.now();
		const oldest = new Date(now - 30 * 86400_000);
		const dueAt = sql`CASE WHEN json_valid(${verification.value})
			THEN max(coalesce(json_extract(${verification.value}, '$.sweepAt'), ${verification.expiresAt}),
				coalesce(json_extract(${verification.value}, '$.claimedUntil'), 0))
			ELSE ${verification.expiresAt} END`;
		const rows = await db
			.select()
			.from(verification)
			.where(sql`${verification.identifier} GLOB ${CONNECT_PREFIX + "*"}
				AND (${verification.createdAt} < ${oldest.getTime()} OR ${dueAt} < ${now})`)
			.orderBy(dueAt, verification.createdAt, verification.id)
			.limit(max)
			.all();
		for (const row of rows) {
			if (row.createdAt < oldest || !readMadeFor(row.value)) {
				const deleted = await db
					.delete(verification)
					.where(sameRow(row))
					.returning({ id: verification.id })
					.get();
				if (deleted && row.createdAt < oldest) {
					const made = readMadeFor(row.value);
					console.warn("connect: expired after 30 days", {
						rowId: deleted.id,
						workspaceId: made?.workspaceId,
						keyId: made?.keyId,
						...(made?.kind === "source" ? { sourceId: made.sourceId } : { agentId: made?.agentId }),
					});
				}
				continue;
			}
			const claimed = await db
				.update(verification)
				.set({
					value: sql`json_set(${verification.value}, '$.claimedUntil', ${Date.now() + CLAIM_MS}, '$.claimNonce', ${crypto.randomUUID()})`,
					expiresAt: new Date(Date.now() + ROW_KEPT_MS),
				})
				.where(sameRow(row))
				.returning()
				.get();
			if (claimed) await cleanClaim(claimed, "code not used");
		}
		return rows.length;
	} catch (error) {
		console.error("connect: could not sweep codes that were not used", error);
		return 0;
	}
}

/** The daily run's sweep: all that are due, within a bound. */
export async function sweepAllConnections(): Promise<void> {
	for (let round = 0; round < SWEEP_ROUNDS; round++) {
		if ((await sweepConnections(SWEEP_ROUND)) < SWEEP_ROUND) return;
	}
}

async function exchange(body: unknown): Promise<Response> {
	const parsed = exchangeBody.safeParse(body);
	if (!parsed.success) return json(NO_CODE, 400);
	const { code, verifier } = parsed.data;
	const identifier = await identifierOf(code);

	const row = await db
		.select()
		.from(verification)
		.where(eq(verification.identifier, identifier))
		.get();
	if (!row) return json(NO_CODE, 400);
	let metadata: Record<string, unknown> | null;
	try {
		metadata = JSON.parse(row.value);
	} catch {
		metadata = null;
	}
	if (metadata?.spent || metadata?.claimedUntil !== undefined) return json(NO_CODE, 400);
	const refuse = async () => {
		const claimed = await db
			.update(verification)
			.set({
				expiresAt: new Date(Date.now() + ROW_KEPT_MS),
				value: JSON.stringify({
					...metadata,
					spent: true,
					claimNonce: crypto.randomUUID(),
					claimedUntil: Date.now() + CLAIM_MS,
					sweepAt: metadata?.sweepAt ?? 0,
				}),
			})
			.where(sameRow(row))
			.returning()
			.get();
		if (claimed) await cleanClaim(claimed, "code refused");
		return json(NO_CODE, 400);
	};
	if (goodUntilOf(row) <= Date.now()) return refuse();

	let keep: z.infer<typeof stored>;
	try {
		keep = stored.parse(JSON.parse(row.value));
	} catch {
		return refuse();
	}
	if (!sameText(await challengeOf(verifier), keep.challenge)) return refuse();

	let sealed: Sealed;
	try {
		sealed = JSON.parse(await open(code, identifier, keep)) as Sealed;
	} catch {
		return refuse();
	}
	if ((sealed.kind ?? "agent") !== keep.kind) return refuse();
	if (sealed.kind === "source" && (demoEnabled() || keep.state !== "ready")) return refuse();
	if (goodUntilOf(row) <= Date.now()) return refuse();
	if (!(await db.delete(verification).where(sameRow(row)).returning({ id: verification.id }).get()))
		return json(NO_CODE, 400);
	if (sealed.kind === "source") {
		const { sourceKey, endpoint, source, workspace, team, undo } = sealed;
		return json(
			{ sourceKey, endpoint, source, workspace, team, undo, undoUntil: sealed.undoUntil },
			200,
		);
	}
	return json(
		{
			agentKey: sealed.agentKey,
			webhookSecret: sealed.webhookSecret,
			agent: sealed.agent,
			workspace: sealed.workspace,
			webhook: sealed.webhook,
			undo: sealed.undo,
		},
		200,
	);
}

async function undo(body: unknown): Promise<Response> {
	const token = z.object({ undo: z.string().max(512) }).safeParse(body);
	const target = token.success ? await readUndoToken(token.data.undo) : null;
	if (!target) return json(NO_UNDO, 400);
	if (target.kind === "source" && demoEnabled()) return json(NO_UNDO, 400);
	try {
		if (target.kind === "source") {
			const now = Date.now();
			const id = "track-source-undo:" + target.keyId;
			const made = { ...target, state: "undo" as const };
			const value = JSON.stringify({
				...made,
				sweepAt: 0,
				claimedUntil: now + CLAIM_MS,
				claimNonce: crypto.randomUUID(),
			});
			const expiresAt = new Date(now + ROW_KEPT_MS);
			let row = await db
				.insert(verification)
				.values({
					id,
					identifier: CONNECT_PREFIX + id,
					value,
					expiresAt,
				})
				.onConflictDoNothing()
				.returning()
				.get();
			if (!row) {
				const previous = await db.select().from(verification).where(eq(verification.id, id)).get();
				if (previous && JSON.parse(previous.value).claimedUntil <= now)
					row = await db
						.update(verification)
						.set({ value, expiresAt })
						.where(sameRow(previous))
						.returning()
						.get();
			}
			if (row && (await takeBackSource(row, made, "undo")) !== "retry")
				await db.delete(verification).where(sameRow(row)).run();
		} else await takeBack(target.workspaceId, target.agentId);
	} catch (error) {
		console.error("connect: undo did not finish", error);
		return json({ error: "try_again" }, 500);
	}
	// The same whether they were there or not, so a token tells nothing about what is left.
	return json({ ok: true }, 200);
}

/** What the page shows, once the person is known to be signed in and the request is sound. */
export type ConnectOffer =
	| { ok: false; problem: string }
	| {
			ok: true;
			/** Who is asking, as an origin. */
			asker: string;
			/** Listed in `CONNECT_ORIGINS`. */
			known: boolean;
			purpose: ConnectPurpose;
			suggestedName: string;
			events: string[];
			/** The workspaces the person is an owner or admin of, by D1. */
			workspaces: { slug: string; name: string }[];
	  };

export async function connectOffer(query: string, request: Request): Promise<ConnectOffer> {
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return { ok: false, problem: "You are signed out. Start again from the app." };
	const checked = checkConnectRequest(query, appOrigin(request));
	if (!checked.ok) return checked;
	if (!webhooksEnabled()) {
		return { ok: false, problem: "This server sends no webhooks, so it cannot connect an agent." };
	}
	const workspaces = await adminWorkspaces(session.user.id);
	if (workspaces.length === 0) {
		return {
			ok: false,
			problem: "You are not an owner or admin of any workspace, so you cannot add an agent.",
		};
	}
	const { request: asked } = checked;
	return {
		ok: true,
		asker: asked.origin,
		known: parseConnectOrigins(env.CONNECT_ORIGINS).has(asked.origin),
		purpose: asked.purpose,
		suggestedName: asked.name,
		events: asked.events,
		workspaces,
	};
}

async function adminWorkspaces(userId: string) {
	return (await listWorkspaces(db, userId))
		.filter((each) => isAdminRole(each.role))
		.map(({ slug, name }) => ({ slug, name }));
}

export async function sourceConnectOffer(query: string, request: Request) {
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session)
		return { ok: false as const, problem: "You are signed out. Start again from the app." };
	if (demoEnabled())
		return { ok: false as const, problem: "This server does not accept source events." };
	const checked = checkSourceConnectRequest(query, appOrigin(request));
	if (!checked.ok) return checked;
	const workspaces = await adminWorkspaces(session.user.id);
	if (!workspaces.length)
		return {
			ok: false as const,
			problem: "Only workspace owners and admins can connect a source.",
		};
	const { origin, product, name, linkOrigins, otherLinkOrigins } = checked.request;
	return {
		ok: true as const,
		asker: origin,
		known: parseConnectOrigins(env.CONNECT_ORIGINS).has(origin),
		product,
		name,
		linkOrigins,
		otherLinkOrigins,
		workspaces,
	};
}

export async function sourceConnectChoices(slug: string, request: Request) {
	if (demoEnabled()) return null;
	const session = await getAuth().api.getSession({ headers: request.headers });
	const membership = session && (await findMembership(db, slug, session.user.id));
	if (!membership || !isAdminRole(membership.profile.role)) return null;
	const { teams, members } = await workspaceStub(membership).directory();
	return {
		teams: teams.map(({ id, key, name }) => ({ id, key, name })),
		agents: members
			.filter((m) => m.role === "agent" && m.removedAt === null)
			.map(({ id, name }) => ({ id, name })),
	};
}

/** A workspace's teams, by id, key and name only (a team holds secrets the page does not need). */
export async function connectTeams(slug: string, request: Request) {
	const session = await getAuth().api.getSession({ headers: request.headers });
	const membership = session && (await findMembership(db, slug, session.user.id));
	if (!membership || !isAdminRole(membership.profile.role)) return null;
	const directory = await workspaceStub(membership).directory();
	return directory.teams.map(({ id, key, name }) => ({ id, key, name }));
}

export type Approval = { ok: true; redirect: string } | { ok: false; message: string };

export interface ApprovalInput {
	/** The page's own query, which is checked again here. */
	query: string;
	decision: "allow" | "cancel";
	workspace: string;
	teamId: string | null;
	name: string;
}

const agentName = z.string().trim().min(1).max(MAX_AGENT_NAME_LENGTH);
const refused = (message: string): Approval => ({ ok: false, message });

/** Allow or Cancel. The answer is where the person goes next; it never holds a secret. */
export async function decideConnection(input: ApprovalInput, request: Request): Promise<Approval> {
	// A change made by a page of this app only. Browsers send the origin on every POST.
	if (request.headers.get("origin") !== appOrigin(request)) {
		return refused("This request did not come from Track's own page.");
	}
	const checked = checkConnectRequest(input.query, appOrigin(request));
	if (!checked.ok) return refused(checked.problem);
	const asked = checked.request;
	if (input.decision === "cancel") {
		return {
			ok: true,
			redirect: returnAddress(asked.returnTo, { error: "denied", state: asked.state }),
		};
	}

	const auth = getAuth();
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return refused("You are signed out. Sign in and start again from the app.");
	if (!webhooksEnabled()) return refused("This server sends no webhooks.");
	// The same answer for a workspace that does not exist, one the person is not in, and one they
	// are only a member of.
	const membership = await findMembership(db, input.workspace, session.user.id);
	if (!membership || !isAdminRole(membership.profile.role)) {
		return refused("Only an owner or admin of a workspace can add an agent to it.");
	}
	const name = agentName.safeParse(input.name);
	if (!name.success) {
		return refused(`Give the agent a name of 1 to ${MAX_AGENT_NAME_LENGTH} characters.`);
	}
	if (!(await allowConnectApproval(session.user.id))) {
		return refused("You have connected agents too often. Try again in a while.");
	}

	const { workspaceId } = membership;
	const headers = request.headers;
	// Codes that nobody traded, which left an agent and a webhook behind: a few, so Allow stays fast.
	await sweepConnections(SWEEP_ON_APPROVAL);
	// The agent first. It awaits the new member's sync to the workspace's object.
	let made: { agent: { id: string }; key: string };
	try {
		// A failure after its member is made is cleaned up by the plugin itself, which knows the id.
		made = await auth.api.createAgent({
			headers,
			body: { organizationId: workspaceId, name: name.data },
		});
	} catch (error) {
		return refused(messageOf(error, "The agent member could not be made."));
	}
	const agentId = made.agent.id;
	// The key just made, the agent's only one, read before anything else is awaited: how a later
	// take-back tells that nobody has taken the agent over since.
	// A read that fails must not leave the agent behind with nothing to take it back: without the
	// id, a take-back goes by the count of keys alone.
	const keyId = await db
		.select({ id: schema.agentKey.id })
		.from(schema.agentKey)
		.where(
			and(eq(schema.agentKey.userId, agentId), eq(schema.agentKey.organizationId, workspaceId)),
		)
		.all()
		.then(([first]) => first?.id)
		.catch(() => undefined);
	const stub = workspaceStub(membership);
	// Takes both back: the webhooks that name this agent first (this request made the agent, so
	// they are its own, whether or not an answer about one arrived), then the agent.
	const undone = async (why: string): Promise<Approval> => {
		let hooksGone = true;
		try {
			await stub.removeConnectedWebhooksOf(agentId);
		} catch (error) {
			hooksGone = false;
			console.error("connect: could not remove the webhook again", error);
		}
		// With a webhook that may still be there, the agent stays, so it never points at nothing.
		const removed = hooksGone && (await removeAgentAgain(headers, agentId));
		return refused(
			removed
				? `${why} Nothing was made.`
				: `${why} The agent member ${name.data} was made and could not be removed again: delete it, and any webhook for it, in Settings.`,
		);
	};

	const webhookInput = {
		url: asked.webhook,
		events: asked.events,
		teamId: input.teamId,
		agentId,
	};
	const link = { id: workspaceId, slug: input.workspace, origin: appOrigin(request) };
	let created: Awaited<ReturnType<typeof stub.createWebhook>>;
	try {
		created = await stub.createWebhook(membership.profile, link, webhookInput);
		if (!created.ok && created.reason === "not_found" && created.message === "Agent not found") {
			// The workspace had not heard of the agent yet: its sync failed. Once more, then give up.
			await syncMembership(db, workspaceId, agentId);
			created = await stub.createWebhook(membership.profile, link, webhookInput);
		}
	} catch (error) {
		console.error("connect: the workspace did not take the webhook", error);
		return undone("The workspace could not be reached.");
	}
	if (!created.ok) return undone(created.message);
	const webhookId = created.value.webhook.id;

	const code = randomBase64Url(32);
	const identifier = await identifierOf(code);
	try {
		const memberRow = await db
			.select({ id: schema.member.id })
			.from(schema.member)
			.where(eq(schema.member.userId, agentId))
			.get();
		const sealed: Sealed = {
			kind: "agent",
			agentKey: made.key,
			webhookSecret: created.value.secret,
			agent: { id: agentId, memberId: memberRow?.id ?? agentId, name: name.data },
			workspace: { id: workspaceId, slug: input.workspace, name: membership.workspaceName },
			webhook: { id: webhookId },
			undo: await undoToken(workspaceId, agentId, webhookId),
			returnOrigin: asked.origin,
		};
		const now = Date.now();
		await db
			.insert(schema.verification)
			.values({
				id: crypto.randomUUID(),
				identifier,
				value: JSON.stringify({
					v: 1,
					kind: "agent",
					challenge: asked.challenge,
					// Not secret: what a refused or untraded code takes back, without opening the seal.
					workspaceId,
					agentId,
					...(keyId && { keyId }),
					origin: asked.origin,
					// The code's own minute, and when the sweep may take back what nobody traded for.
					goodUntil: now + CODE_TTL_MS,
					sweepAt: now + CODE_TTL_MS,
					...(await seal(code, identifier, asked.challenge, JSON.stringify(sealed))),
				}),
				// Kept past the code's minute, so the row is still there to be swept.
				expiresAt: new Date(now + CODE_TTL_MS + ROW_KEPT_MS),
			})
			.run();
	} catch (error) {
		console.error("connect: could not keep the one-time code", error);
		// Neither is of use to anyone without it: take both back.
		return undone("Track could not prepare the connection.");
	}

	await reportAudit(db, workspaceId, {
		actorId: session.user.id,
		action: "agent.connected",
		target: { type: "agent", id: agentId, label: name.data },
		detail: { origin: asked.origin, webhook: webhookId },
	}).catch((error) => console.error("connect: audit log", error));

	return { ok: true, redirect: returnAddress(asked.returnTo, { code, state: asked.state }) };
}

interface SourceApprovalInput {
	query: string;
	decision: "allow" | "cancel";
	workspace: string;
	teamId: string;
	lowestSeverity: SourceThreshold;
	closeWhenCleared: boolean;
	assigneeId: string | null;
}

export async function decideSourceConnection(
	input: SourceApprovalInput,
	request: Request,
): Promise<Approval> {
	const origin = appOrigin(request);
	if (request.headers.get("origin") !== origin)
		return refused("This request did not come from Track's own page.");
	if (demoEnabled()) return refused("This server does not accept source events.");
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return refused("You are signed out. Sign in and start again from the app.");
	const checked = checkSourceConnectRequest(input.query, origin);
	if (!checked.ok) return refused(checked.problem);
	const asked = checked.request;
	if (input.decision === "cancel")
		return {
			ok: true,
			redirect: returnAddress(asked.returnTo, { error: "denied", state: asked.state }),
		};
	const membership = await findMembership(db, input.workspace, session.user.id);
	if (!membership || !isAdminRole(membership.profile.role))
		return refused("Only an owner or admin of a workspace can connect a source.");
	if (!(await allowConnectApproval(session.user.id)))
		return refused("You have connected apps too often. Try again in a while.");
	await sweepConnections(SWEEP_ON_APPROVAL);
	const { workspaceId } = membership;
	const stub = workspaceStub(membership);
	const sourceId = crypto.randomUUID();
	const key = newSourceKey();
	const code = randomBase64Url(32);
	const identifier = await identifierOf(code);
	const rowId = crypto.randomUUID();
	const pending = {
		kind: "source" as const,
		state: "pending" as const,
		workspaceId,
		sourceId,
		keyId: key.id,
		origin: asked.origin,
	};
	const now = Date.now();
	const notAfter = now + CODE_TTL_MS;
	const row = {
		id: rowId,
		value: JSON.stringify({
			...pending,
			allowNonce: crypto.randomUUID(),
			goodUntil: 0,
			sweepAt: notAfter,
		}),
	};
	const requirePending = async () => {
		if (!(await stillHeld(row))) throw new Error("approval expired");
	};
	let mayHaveSource = false;
	let failure = "Track could not prepare the connection.";
	try {
		const { teams } = await stub.directory();
		const found = teams.find((team) => team.id === input.teamId);
		if (!found) return refused("Choose a team in this workspace.");
		const team = { id: found.id, key: found.key, name: found.name };
		// Even an interrupted Allow leaves the sweep the ids it needs, including before the first
		// key exists. Only the transition to ready below starts the code's own minute.
		await db
			.insert(schema.verification)
			.values({
				id: rowId,
				identifier,
				value: row.value,
				expiresAt: new Date(now + CODE_TTL_MS + ROW_KEPT_MS),
			})
			.run();
		await requirePending();
		mayHaveSource = true;
		const created = await stub.manageSource(session.user.id, {
			kind: "create",
			id: sourceId,
			notAfter,
			input: {
				teamId: team.id,
				product: asked.product,
				name: asked.name,
				linkOrigins: asked.linkOrigins,
				lowestSeverity: input.lowestSeverity,
				closeWhenCleared: input.closeWhenCleared,
			},
		});
		if (!created.ok) {
			// The object definitely refused the insert. In particular, an id already in use belongs
			// to someone else and must never be rolled back by this request.
			mayHaveSource = false;
			failure = created.message;
			throw new Error("source refused");
		}
		const keyFence = () => sql`${holds(row)} and ${Date.now()} <= ${notAfter}`;
		if (!(await makeSourceKey(db, workspaceId, sourceId, key, keyFence)))
			throw new Error("key refused");
		const issued = await stub.manageSource(session.user.id, { kind: "keyCreated", id: sourceId });
		if (!issued.ok) throw new Error("source no longer accepts keys");
		if (input.assigneeId !== null) {
			await requirePending();
			const assigned = await stub.manageSource(session.user.id, {
				kind: "assign",
				id: sourceId,
				assigneeId: input.assigneeId,
			});
			if (!assigned.ok) {
				failure = assigned.message;
				throw new Error("assignment refused");
			}
		}
		const expiry = Math.floor(Date.now() / 1000) + SOURCE_UNDO_SECONDS;
		const sealed: SourceSealed = {
			kind: "source",
			sourceKey: key.secret,
			endpoint: new URL("/api/events", origin).href,
			source: { id: sourceId, name: asked.name, product: asked.product },
			workspace: { id: workspaceId, slug: input.workspace, name: membership.workspaceName },
			team,
			undo: await signUndo(SOURCE_UNDO_PURPOSE, ["source", workspaceId, sourceId, key.id], expiry),
			undoUntil: new Date(expiry * 1000).toISOString(),
		};
		const ciphertext = await seal(code, identifier, asked.challenge, JSON.stringify(sealed));
		const until = Date.now() + CODE_TTL_MS;
		const ready = await db
			.update(schema.verification)
			.set({
				value: JSON.stringify({
					...pending,
					state: "ready",
					v: 1,
					challenge: asked.challenge,
					goodUntil: until,
					sweepAt: until,
					...ciphertext,
				}),
			})
			.where(sameRow(row))
			.returning({ id: schema.verification.id })
			.get();
		if (!ready) throw new Error("approval expired");
	} catch {
		try {
			// A lost ready reply or a sweep transfers ownership away from this pending value.
			const status = mayHaveSource ? await takeBackSource(row, pending, "approval failed") : "gone";
			if (status !== "retry" && status !== "withinGrace")
				await db.delete(verification).where(sameRow(row)).run();
		} catch {
			// The pending row stays for the sweep if either store was unavailable.
		}
		return refused(failure);
	}
	await reportAudit(db, workspaceId, {
		actorId: session.user.id,
		action: "source.connected",
		target: { type: "source", id: sourceId, label: asked.name },
		detail: { origin: asked.origin },
	}).catch((error) => console.error("connect: audit log", error));
	return { ok: true, redirect: returnAddress(asked.returnTo, { code, state: asked.state }) };
}

async function removeAgentAgain(headers: Headers, agentId: string): Promise<boolean> {
	try {
		await getAuth().api.deleteAgent({ headers, body: { agentId } });
		return true;
	} catch (error) {
		console.error("connect: could not remove the agent again", error);
		return false;
	}
}

/** What Better Auth's error says, where it says anything a person can read. */
function messageOf(error: unknown, fallback: string): string {
	const body: unknown = error instanceof Error ? (error as { body?: unknown }).body : null;
	const message = z.object({ message: z.string().max(300) }).safeParse(body);
	return message.success ? message.data.message : fallback;
}

// The one-time code's row.

async function identifierOf(code: string): Promise<string> {
	return `${CONNECT_PREFIX}${toBase64Url(await sha256(new TextEncoder().encode(code)))}`;
}

/** What the challenge for a verifier is: its SHA-256 as unpadded base64url. */
async function challengeOf(verifier: string): Promise<string> {
	return toBase64Url(await sha256(new TextEncoder().encode(verifier)));
}

/**
 * The key that seals a row: HKDF of the secret, salted with the code, so the key is made from
 * something the row does not hold and the code alone, or the row alone, opens nothing.
 */
async function sealKey(code: string, usage: "encrypt" | "decrypt") {
	const secret = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode(code),
			info: new TextEncoder().encode(SEAL_PURPOSE),
		},
		secret,
		{ name: "AES-GCM", length: 256 },
		false,
		[usage],
	);
}

/**
 * Binds a seal to its row's identifier, its purpose and its challenge, so it opens nowhere else,
 * and not under a challenge that someone able to write to the table put in its place.
 */
function bound(identifier: string, challenge: string) {
	return new TextEncoder().encode(`${SEAL_PURPOSE}:${identifier}:${challenge}`);
}

async function seal(code: string, identifier: string, challenge: string, plaintext: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: bound(identifier, challenge) },
		await sealKey(code, "encrypt"),
		new TextEncoder().encode(plaintext),
	);
	return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

async function open(
	code: string,
	identifier: string,
	keep: { iv: string; ct: string; challenge: string },
) {
	const iv = fromBase64Url(keep.iv);
	const ct = fromBase64Url(keep.ct);
	if (!iv || !ct) throw new Error("malformed");
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, additionalData: bound(identifier, keep.challenge) },
		await sealKey(code, "decrypt"),
		ct,
	);
	return new TextDecoder().decode(plain);
}

// The undo token.

async function undoKey(purpose: string) {
	const secret = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(),
			info: new TextEncoder().encode(purpose),
		},
		secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function undoMessage(purpose: string, parts: string[]) {
	return new TextEncoder().encode([purpose, ...parts].join(":"));
}

async function signUndo(purpose: string, ids: string[], expiry: number) {
	const expires = String(expiry);
	const parts = [...ids, expires];
	const mac = await crypto.subtle.sign("HMAC", await undoKey(purpose), undoMessage(purpose, parts));
	return [...parts, toBase64Url(new Uint8Array(mac))].join(".");
}

/** Keep the original agent token's wire format and MAC. */
export function undoToken(
	workspaceId: string,
	agentId: string,
	webhookId: string,
	now = Date.now(),
) {
	return signUndo(
		UNDO_PURPOSE,
		[workspaceId, agentId, webhookId],
		Math.floor(now / 1000) + UNDO_TTL_SECONDS,
	);
}

async function readUndoToken(token: string) {
	const parts = token.split(".");
	const signature = parts.pop() ?? "";
	const mac = fromBase64Url(signature);
	if (!mac || mac.length !== 32) return null;
	const source = parts.length === 5 && parts[0] === "source";
	const [workspaceId = "", id = "", linkedId = "", expires = "", ...extra] = source
		? parts.slice(1)
		: parts;
	if (extra.length || !/^\d{1,12}$/.test(expires) || Number(expires) * 1000 <= Date.now())
		return null;
	if (![workspaceId, id, linkedId].every((part) => ID.test(part))) return null;
	// Each kind signs under its own key and purpose. Its format must also agree with that key.
	for (const purpose of [UNDO_PURPOSE, SOURCE_UNDO_PURPOSE]) {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await undoKey(purpose),
			mac,
			undoMessage(purpose, parts),
		);
		if (!valid) continue;
		if (source && purpose === SOURCE_UNDO_PURPOSE)
			return { kind: "source" as const, workspaceId, sourceId: id, keyId: linkedId };
		if (!source && purpose === UNDO_PURPOSE)
			return { kind: "agent" as const, workspaceId, agentId: id };
	}
	return null;
}

// Small helpers.

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			// A code or a key in a cache is a code or a key someone else may read.
			"cache-control": "no-store",
			...headers,
		},
	});
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function randomBase64Url(length: number): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
	try {
		const padded = value.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

/** Whether two strings are equal, taking as long for any that differ at the same length. */
function sameText(one: string, other: string): boolean {
	const a = new TextEncoder().encode(one);
	const b = new TextEncoder().encode(other);
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return difference === 0;
}
