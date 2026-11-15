import { env } from "cloudflare:workers";
import { isAdminRole } from "@gateweave/track-protocol";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type ConnectPurpose,
	checkConnectRequest,
	MAX_AGENT_NAME_LENGTH,
	parseConnectOrigins,
	returnAddress,
} from "../lib/connect-request";
import { appOrigin, db, getAuth } from "./auth";
import { removeAgentOf } from "./auth/agents";
import { countedByWhoSentIt } from "./auth/workers-address";
import { readText } from "./body";
import { schema } from "./db";
import { allowConnectApproval, limitConnectCalls } from "./rate-limit";
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
/**
 * How long a code's row stays in the table after the code itself has run out. Better Auth deletes
 * every row of `verification` past its `expiresAt` whenever it looks one up, and so does the daily
 * prune, so a row whose `expiresAt` were the code's own minute would usually be gone before anyone
 * could take back what it was made for. The code's minute is `goodUntil` inside the row instead,
 * and `expiresAt` is this much later: long enough for a daily run that was missed twice.
 */
const ROW_KEPT_MS = 3 * 24 * 60 * 60 * 1000;
/** A take-back that failed is tried again this much later, at most this many times. */
const TAKE_BACK_AGAIN_MS = 60 * 60 * 1000;
const TAKE_BACK_TRIES = 3;
const UNDO_TTL_SECONDS = 10 * 60;
/** A code row's `identifier`, so no other use of the `verification` table can be mistaken for one. */
const IDENTIFIER_PREFIX = "track-connect:";
/** The purposes the secret is used under, each its own key, and part of what a seal binds to. */
const SEAL_PURPOSE = "track-connect-code-v1";
const UNDO_PURPOSE = "track-connect-undo-v1";
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
interface Sealed {
	agentKey: string;
	webhookSecret: string;
	agent: { id: string; memberId: string; name: string };
	workspace: { id: string; slug: string; name: string };
	webhook: { id: string };
	undo: string;
	returnOrigin: string;
}

/** What the row keeps in `value`: the challenge in the clear, the rest sealed under the code. */
const stored = z.object({
	v: z.literal(1),
	challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	iv: z.string(),
	ct: z.string(),
});

/**
 * What a row says in the clear about what it was made for, so that a code that is refused or never
 * traded can be taken back without opening the seal. These are ids, not secrets. A row written
 * before they were kept (v0.39.0) has none, and there is nothing to take back for it.
 */
const madeFor = z.object({
	workspaceId: z.string().regex(ID),
	agentId: z.string().regex(ID),
	origin: z.string().max(200).optional(),
	/** How often taking it back has failed so far. */
	tries: z.number().int().min(0).max(TAKE_BACK_TRIES).optional(),
});
type MadeFor = z.infer<typeof madeFor>;

function readMadeFor(value: string): MadeFor | null {
	try {
		const read = madeFor.safeParse(JSON.parse(value));
		return read.success ? read.data : null;
	} catch {
		return null;
	}
}

/**
 * Takes back what a connection made: the webhooks that name the agent first, then the agent, then
 * the membership sync. Safe to repeat. Throws when it could not finish. The audit event is
 * Track's own, whatever `detail` is added.
 */
async function takeBack(workspaceId: string, agentId: string, detail: Record<string, string> = {}) {
	// The workspace must still exist in D1 before its object is reached, which reaching it makes.
	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	if (!workspace) return;
	// The webhook first: with it gone, nothing is sent to an agent that no longer exists.
	const stub = await findWorkspaceStub(db, workspaceId);
	// Every webhook that names the agent, which can only be one made for it: it covers one this
	// caller does not know of.
	await stub.removeConnectedWebhooksOf(agentId);
	const removed = await removeAgentOf(db, workspaceId, agentId);
	// Whether or not this call removed it: an earlier one may have deleted the rows and then
	// failed to tell the object, and a retry would otherwise never tell it.
	await syncMembership(db, workspaceId, agentId);
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

type CodeRow = { identifier: string; value: string; expiresAt: Date };

/**
 * Takes back what a deleted row was made for. When that fails, which a workspace's object being
 * restarted is enough for, the row goes back in as one whose code opens nothing any more
 * (`goodUntil: 0`) and that the sweep tries again later, a few times. Only logs, with no secret.
 */
async function takeBackFor(row: CodeRow, reason: string): Promise<void> {
	const made = readMadeFor(row.value);
	if (!made) return;
	try {
		await takeBack(made.workspaceId, made.agentId, {
			reason,
			...(made.origin && { origin: made.origin }),
		});
	} catch (error) {
		console.error("connect: could not take back a connection whose code was not used", error);
		const tries = (made.tries ?? 0) + 1;
		if (tries >= TAKE_BACK_TRIES) return;
		try {
			await db
				.insert(schema.verification)
				.values({
					id: crypto.randomUUID(),
					identifier: row.identifier,
					// Only what taking it back needs: the sealed part is of no use to anyone now.
					value: JSON.stringify({
						...made,
						tries,
						goodUntil: 0,
						sweepAt: Date.now() + TAKE_BACK_AGAIN_MS,
					}),
					expiresAt: new Date(Date.now() + ROW_KEPT_MS),
				})
				.run();
		} catch (again) {
			console.error("connect: could not keep a connection to take back later", again);
		}
	}
}

/**
 * Takes back what codes past their minute were made for, a few at a time. Each row is deleted
 * with `DELETE ... RETURNING`, so a sweep and a late exchange cannot both act on one row, and what
 * is taken back is only what a row just deleted names: never an agent whose code was traded (its
 * row is gone) or one made by hand. Answers how many rows it cleared. Never throws.
 */
export async function sweepConnections(max: number): Promise<number> {
	try {
		// By `sweepAt` in the row, not `expiresAt`, which is days later (see ROW_KEPT_MS). A row
		// without one (v0.39.0) names nothing to take back and is left to the prune.
		const due = and(
			like(schema.verification.identifier, `${IDENTIFIER_PREFIX}%`),
			sql`json_extract(${schema.verification.value}, '$.sweepAt') < ${Date.now()}`,
		);
		const rows = await db
			.delete(schema.verification)
			.where(
				and(
					due,
					inArray(
						schema.verification.id,
						db
							.select({ id: schema.verification.id })
							.from(schema.verification)
							.where(due)
							.limit(max),
					),
				),
			)
			.returning()
			.all();
		for (const row of rows) await takeBackFor(row, "code not used");
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

	// The delete decides: whoever's statement removes the row is the one that goes on, so two
	// exchanges at once cannot both succeed, and a code that fails below is spent all the same.
	const [row] = await db
		.delete(schema.verification)
		.where(eq(schema.verification.identifier, identifier))
		.returning()
		.all();
	if (!row) return json(NO_CODE, 400);
	// The code is spent and nobody was given what it made, with no token to undo it: so it is
	// taken back here. The answer is the same whichever check failed.
	const refuse = async () => {
		await takeBackFor(row, "code refused");
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
	const { workspaceId, agentId } = target;

	try {
		await takeBack(workspaceId, agentId);
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
	const workspaces = (await listWorkspaces(db, session.user.id)).filter((each) =>
		isAdminRole(each.role),
	);
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
		workspaces: workspaces.map(({ slug, name }) => ({ slug, name })),
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
					challenge: asked.challenge,
					// Not secret: what a refused or untraded code takes back, without opening the seal.
					workspaceId,
					agentId,
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
	return `${IDENTIFIER_PREFIX}${toBase64Url(await sha256(new TextEncoder().encode(code)))}`;
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

async function undoKey() {
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
			info: new TextEncoder().encode(UNDO_PURPOSE),
		},
		secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function undoMessage(workspaceId: string, agentId: string, webhookId: string, expires: string) {
	return new TextEncoder().encode(
		`${UNDO_PURPOSE}:${workspaceId}:${agentId}:${webhookId}:${expires}`,
	);
}

/** A token that names one workspace, agent member and webhook, good for ten minutes. */
export async function undoToken(
	workspaceId: string,
	agentId: string,
	webhookId: string,
	now = Date.now(),
): Promise<string> {
	const expires = String(Math.floor(now / 1000) + UNDO_TTL_SECONDS);
	const mac = await crypto.subtle.sign(
		"HMAC",
		await undoKey(),
		undoMessage(workspaceId, agentId, webhookId, expires),
	);
	return [workspaceId, agentId, webhookId, expires, toBase64Url(new Uint8Array(mac))].join(".");
}

async function readUndoToken(token: string) {
	const [workspaceId = "", agentId = "", webhookId = "", expires = "", signature = "", ...rest] =
		token.split(".");
	if (rest.length > 0 || !/^\d{1,12}$/.test(expires)) return null;
	if (![workspaceId, agentId, webhookId].every((part) => ID.test(part))) return null;
	const mac = fromBase64Url(signature);
	if (!mac || mac.length !== 32) return null;
	// `verify` compares in constant time.
	const valid = await crypto.subtle.verify(
		"HMAC",
		await undoKey(),
		mac,
		undoMessage(workspaceId, agentId, webhookId, expires),
	);
	if (!valid || Number(expires) * 1000 <= Date.now()) return null;
	return { workspaceId, agentId, webhookId };
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
