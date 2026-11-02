import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	type ActiveIssue,
	type Activity,
	type ClientMessage,
	isActiveIssue,
	type MutationInput,
	type Op,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SyncedIssue,
} from "@gateweave/track-protocol";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { MEMBER_HEADER, type MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { toActivity } from "../src/state";

export function freshWorkspace() {
	return env.WORKSPACE.getByName(crypto.randomUUID());
}

export type Workspace = ReturnType<typeof freshWorkspace>;

/** A replica's issue, whole: an archived issue's slim row, or none, fails the test. */
export function whole(issue: SyncedIssue | undefined): ActiveIssue {
	if (!issue) throw new Error("No such issue");
	if (!isActiveIssue(issue)) throw new Error(`Issue ${issue.id} is archived`);
	return issue;
}

/**
 * An issue's history as the workspace stores it, in the order it was written. Unlike a snapshot's,
 * it includes an archived issue's history, which replicas do not hold.
 */
export function storedHistory(workspace: Workspace, issueId: string): Promise<Activity[]> {
	return runInDurableObject(workspace, (_, state) =>
		drizzle(state.storage, { schema })
			.select()
			.from(schema.activities)
			.where(eq(schema.activities.issueId, issueId))
			.orderBy(sql`${schema.activities}.rowid`)
			.all()
			.map(toActivity),
	);
}

type Of<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Minimal sync client for driving a WorkspaceDO over a real WebSocket. */
export class TestClient {
	readonly #inbox: ServerMessage[] = [];
	readonly #waiters = new Set<() => void>();
	#closed: { code: number; reason: string } | null = null;
	/** The version the last delta ended at, which the next must start after. */
	#through: number | null = null;
	/** A delta that did not start where the one before ended, which fails the next wait. */
	#gap: string | null = null;

	private constructor(
		private readonly ws: WebSocket,
		readonly clientId: string,
	) {
		ws.addEventListener("message", (event) => {
			const message = JSON.parse(event.data as string) as ServerMessage;
			if (message.type === "delta") {
				if (this.#through !== null && message.from !== this.#through + 1) {
					this.#gap ??= `Delta from ${message.from} after one through ${this.#through}`;
				}
				this.#through = message.to;
			}
			this.#inbox.push(message);
			this.#notify();
		});
		ws.addEventListener("close", (event) => {
			this.#closed = { code: event.code, reason: event.reason };
			this.#notify();
		});
	}

	static async connect(
		workspace: Workspace,
		member: MemberProfile,
		clientId = crypto.randomUUID(),
	) {
		const response = await workspace.fetch("https://workspace/socket", {
			headers: { Upgrade: "websocket", [MEMBER_HEADER]: JSON.stringify(member) },
		});
		const ws = response.webSocket;
		if (!ws) throw new Error(`Upgrade failed with ${response.status}`);
		ws.accept();
		return new TestClient(ws, clientId);
	}

	/** Connects and completes the hello handshake. */
	static async live(workspace: Workspace, member: MemberProfile, clientId?: string) {
		const client = await TestClient.connect(workspace, member, clientId);
		await client.hello();
		return client;
	}

	send(message: ClientMessage | string): void {
		this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
	}

	async hello(since = 0, protocol = PROTOCOL_VERSION): Promise<Of<"ready"> | Of<"reset">> {
		this.#through = since;
		this.send({ type: "hello", protocol, clientId: this.clientId, since });
		return this.take(
			(m): m is Of<"ready"> | Of<"reset"> => m.type === "ready" || m.type === "reset",
		);
	}

	async mutate(
		mutation: MutationInput,
		id = crypto.randomUUID(),
	): Promise<Of<"ack"> | Of<"reject">> {
		this.send({ type: "mutate", id, mutation });
		return this.take(
			(m): m is Of<"ack"> | Of<"reject"> =>
				(m.type === "ack" || m.type === "reject") && m.id === id,
		);
	}

	/** Like `mutate`, but fails the test unless the mutation is acked. */
	async apply(mutation: MutationInput, id?: string): Promise<Of<"ack">> {
		const result = await this.mutate(mutation, id);
		if (result.type !== "ack") throw new Error(`Expected ack, got ${JSON.stringify(result)}`);
		return result;
	}

	/** Removes and returns the first queued message matching `predicate`, waiting if needed. */
	async take<T extends ServerMessage>(
		predicate: (message: ServerMessage) => message is T,
	): Promise<T> {
		for (;;) {
			this.#checkRanges();
			const index = this.#inbox.findIndex(predicate);
			if (index !== -1) return this.#inbox.splice(index, 1)[0] as T;
			if (this.#closed) throw new Error(`Socket closed: ${JSON.stringify(this.#closed)}`);
			await this.#nextEvent();
		}
	}

	/** Waits until an op matching `predicate` arrives in a delta. */
	async op(predicate: (op: Op) => boolean): Promise<Op> {
		for (;;) {
			this.#checkRanges();
			const op = this.#inbox.flatMap((m) => (m.type === "delta" ? m.ops : [])).find(predicate);
			if (op) return op;
			if (this.#closed) throw new Error(`Socket closed: ${JSON.stringify(this.#closed)}`);
			await this.#nextEvent();
		}
	}

	async closed(): Promise<{ code: number; reason: string }> {
		while (!this.#closed) await this.#nextEvent();
		return this.#closed;
	}

	/** Ops received so far, in order. */
	ops(): Op[] {
		this.#checkRanges();
		return this.#inbox.flatMap((m) => (m.type === "delta" ? m.ops : []));
	}

	/** The version the latest delta reached. */
	get through(): number | null {
		return this.#through;
	}

	close(): void {
		this.ws.close(1000, "done");
	}

	#checkRanges(): void {
		if (this.#gap) throw new Error(this.#gap);
	}

	#nextEvent(): Promise<void> {
		return new Promise((resolve) => {
			const waiter = () => {
				this.#waiters.delete(waiter);
				resolve();
			};
			this.#waiters.add(waiter);
		});
	}

	#notify(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}
}
