import { DurableObject } from "cloudflare:workers";
import {
	CloseCode,
	clientMessage,
	type HelloMessage,
	MEMBER_ROLES,
	mutationSchema,
	type Op,
	PING,
	PONG,
	PROTOCOL_VERSION,
	type ServerMessage,
	type Snapshot,
} from "@tangent/protocol";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";
import migrations from "../drizzle/migrations";
import * as schema from "./db/schema";
import { compact, currentVersion, oplogFloor, opsSince, type RetentionPolicy } from "./log";
import { applyMutation, MutationRejected } from "./mutations";
import {
	activeMember,
	type Db,
	type MemberProfile,
	readSnapshot,
	removeMember,
	upsertMember,
} from "./state";

/**
 * Header carrying the verified member on socket requests. The Durable Object is only reachable
 * through the app worker's binding, which sets this after checking the session and membership.
 */
export const MEMBER_HEADER = "x-tangent-member";

export const RETENTION: RetentionPolicy = { minOps: 10_000, minAgeMs: 30 * 24 * 60 * 60 * 1000 };
const COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OPS_PAGE_SIZE = 500;

const memberProfile = z.object({
	id: z.string().min(1),
	name: z.string(),
	email: z.string(),
	image: z.string().nullable(),
	role: z.enum(MEMBER_ROLES),
});

/** Per-socket state. Stored as an attachment so it survives hibernation. */
interface SocketState {
	userId: string;
	clientId: string | null;
	/** True once the socket has said hello and been caught up; only live sockets get broadcasts. */
	live: boolean;
}

/** One instance per workspace. Owns the workspace's data and fans changes out to clients. */
export class WorkspaceDO extends DurableObject {
	readonly #db: Db;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#db = drizzle(ctx.storage, { schema });
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			await migrate(this.#db, migrations);
			if ((await ctx.storage.getAlarm()) === null) {
				await ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
			}
		});
	}

	// RPC, called by the app worker after it has verified membership.

	/** Full workspace state. Also refreshes the requesting member's profile. */
	snapshot(member: MemberProfile): Snapshot {
		this.#write(() => upsertMember(this.#db, memberProfile.parse(member), Date.now()));
		return readSnapshot(this.#db);
	}

	syncMember(member: MemberProfile): void {
		this.#write(() => upsertMember(this.#db, memberProfile.parse(member), Date.now()));
	}

	removeMember(userId: string): void {
		this.#write(() => removeMember(this.#db, userId, Date.now()));
		for (const ws of this.ctx.getWebSockets()) {
			if (socketState(ws).userId === userId) {
				ws.close(CloseCode.Forbidden, "Removed from workspace");
			}
		}
	}

	/** Permanently deletes the workspace's data. Called after the workspace itself is deleted. */
	async destroy(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.Forbidden, "Workspace deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	// WebSocket lifecycle

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/socket" || request.headers.get("Upgrade") !== "websocket") {
			return new Response("Not found", { status: 404 });
		}
		const member = memberProfile.safeParse(parseJson(request.headers.get(MEMBER_HEADER)));
		if (!member.success) return new Response("Missing member", { status: 400 });

		this.#write(() => upsertMember(this.#db, member.data, Date.now()));

		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({
			userId: member.data.id,
			clientId: null,
			live: false,
		} satisfies SocketState);
		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		const message = typeof raw === "string" ? clientMessage.safeParse(parseJson(raw)) : null;
		if (!message?.success) {
			ws.close(CloseCode.InvalidMessage, "Invalid message");
			return;
		}
		try {
			if (message.data.type === "hello") this.#hello(ws, message.data);
			else this.#mutate(ws, message.data.id, message.data.mutation);
		} catch (error) {
			// The client reconnects and resends pending mutations; mutation ids keep that safe.
			console.error("sync: unexpected error", error);
			ws.close(1011, "Internal error");
		}
	}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed, or the code is one that cannot be sent back (1005/1006).
		}
	}

	override async alarm(): Promise<void> {
		this.ctx.storage.transactionSync(() => compact(this.#db, Date.now(), RETENTION));
		await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
	}

	// Message handlers. Each runs synchronously, so no other event can interleave with it.

	#hello(ws: WebSocket, hello: HelloMessage): void {
		if (hello.protocol !== PROTOCOL_VERSION) {
			ws.close(CloseCode.ProtocolMismatch, `Server speaks protocol ${PROTOCOL_VERSION}`);
			return;
		}
		const head = currentVersion(this.#db);
		if (hello.since > head || hello.since < oplogFloor(this.#db)) {
			send(ws, { type: "reset" });
			return;
		}

		let cursor = hello.since;
		while (cursor < head) {
			const ops = opsSince(this.#db, cursor, OPS_PAGE_SIZE);
			const last = ops.at(-1);
			if (!last) break;
			send(ws, { type: "delta", ops });
			cursor = last.version;
		}

		ws.serializeAttachment({
			...socketState(ws),
			clientId: hello.clientId,
			live: true,
		} satisfies SocketState);
		send(ws, { type: "ready", version: head });
	}

	#mutate(ws: WebSocket, id: string, body: unknown): void {
		const state = socketState(ws);
		if (!state.live || !state.clientId) {
			ws.close(CloseCode.InvalidMessage, "Send hello before mutating");
			return;
		}
		const member = activeMember(this.#db, state.userId);
		if (!member) {
			ws.close(CloseCode.Forbidden, "Not a workspace member");
			return;
		}
		const mutation = mutationSchema.safeParse(body);
		if (!mutation.success) {
			send(ws, { type: "reject", id, reason: "invalid", message: z.prettifyError(mutation.error) });
			return;
		}

		try {
			const clientId = state.clientId;
			const result = this.#write(() =>
				applyMutation(this.#db, { member, clientId }, id, mutation.data, Date.now()),
			);
			send(ws, { type: "ack", id, version: result.version });
		} catch (error) {
			if (!(error instanceof MutationRejected)) throw error;
			send(ws, { type: "reject", id, reason: error.reason, message: error.message });
		}
	}

	/** Runs a write in a transaction, then broadcasts its ops to every live socket. */
	#write<T extends { ops: Op[] }>(fn: () => T): T {
		const result = this.ctx.storage.transactionSync(fn);
		if (result.ops.length > 0) {
			const payload = JSON.stringify({ type: "delta", ops: result.ops } satisfies ServerMessage);
			for (const ws of this.ctx.getWebSockets()) {
				if (socketState(ws).live) trySend(ws, payload);
			}
		}
		return result;
	}
}

function socketState(ws: WebSocket): SocketState {
	return ws.deserializeAttachment() as SocketState;
}

function send(ws: WebSocket, message: ServerMessage): void {
	trySend(ws, JSON.stringify(message));
}

function trySend(ws: WebSocket, payload: string): void {
	try {
		ws.send(payload);
	} catch {
		// The socket is closing; the client will catch up after reconnecting.
	}
}

function parseJson(text: string | null): unknown {
	if (text === null) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
