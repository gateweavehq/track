import type { Issue, MutationInput } from "@tangent/protocol";
import { inject } from "vitest";
import {
	httpTransport,
	SyncClient,
	type SyncClientOptions,
	type SyncSocket,
	type Transport,
	uuidv7,
} from "../src";

const syncUrl = inject("syncUrl");

export type User = "alice" | "bob" | "mallory";

/**
 * Wraps a user's real transport so a test can cut and restore their network. Sockets are dropped
 * abruptly, the way a lost connection looks to the client, rather than closed cleanly.
 */
export class TestNetwork {
	snapshots = 0;
	connects = 0;
	#online = true;
	readonly #links = new Set<{ drop(): void }>();

	constructor(private readonly inner: Transport) {}

	/** Sockets currently open or opening. */
	get sockets(): number {
		return this.#links.size;
	}

	offline(): void {
		this.#online = false;
		for (const link of [...this.#links]) link.drop();
	}

	online(): void {
		this.#online = true;
	}

	readonly transport: Transport = {
		snapshot: async () => {
			this.#check();
			this.snapshots += 1;
			return this.inner.snapshot();
		},
		probe: async () => {
			this.#check();
			return this.inner.probe();
		},
		connect: (handlers) => {
			this.connects += 1;
			let closed = false;
			let socket: SyncSocket | undefined;
			const link = {
				drop: () => {
					socket?.close();
					finish(1006, "Network down");
				},
			};
			const finish = (code: number, reason: string) => {
				if (closed) return;
				closed = true;
				this.#links.delete(link);
				handlers.close(code, reason);
			};
			this.#links.add(link);

			if (!this.#online) {
				setTimeout(() => finish(1006, ""), 0);
				return { send() {}, close() {} };
			}
			socket = this.inner.connect({
				open: () => {
					if (!closed) handlers.open();
				},
				message: (data) => {
					if (!closed) handlers.message(data);
				},
				close: finish,
			});
			return {
				send: (data) => {
					if (!closed) socket?.send(data);
				},
				close: (code, reason) => {
					socket?.close(code, reason);
					finish(code ?? 1000, reason ?? "");
				},
			};
		},
	};

	#check(): void {
		if (!this.#online) throw new TypeError("fetch failed");
	}
}

interface ClientOptions extends Partial<SyncClientOptions> {
	network?: TestNetwork;
}

/** A fresh workspace on the test worker, plus the clients connected to it. */
export class TestWorkspace {
	readonly id = crypto.randomUUID();
	readonly #clients = new Set<SyncClient>();

	network(user: User): TestNetwork {
		return new TestNetwork(httpTransport({ workspace: this.id, baseUrl: `${syncUrl}/as/${user}` }));
	}

	client(user: User, { network, ...options }: ClientOptions = {}): SyncClient {
		const client = new SyncClient({
			userId: user,
			transport: (network ?? this.network(user)).transport,
			retry: { minDelay: 20, maxDelay: 100 },
			...options,
		});
		this.#clients.add(client);
		return client;
	}

	/** A client that has connected and caught up. */
	async live(user: User, options?: ClientOptions): Promise<SyncClient> {
		const client = this.client(user, options);
		await waitForLive(client);
		return client;
	}

	/** Removes a user from the workspace, as the app does when a member is removed. */
	async remove(user: User): Promise<void> {
		const response = await fetch(`${syncUrl}/admin/${this.id}/remove/${user}`, { method: "POST" });
		if (!response.ok) throw new Error(`Remove failed with ${response.status}`);
	}

	async close(): Promise<void> {
		await Promise.all([...this.#clients].map((client) => client.close()));
	}
}

export async function waitForLive(client: SyncClient): Promise<void> {
	await waitFor(() => client.getStatus().connection === "live");
}

/** Waits until every listed client has no pending mutations and the same server version. */
export async function waitForConvergence(...clients: SyncClient[]): Promise<void> {
	await waitFor(() => {
		const versions = new Set(clients.map((client) => client.getState().version));
		return versions.size === 1 && clients.every((client) => client.getStatus().pending === 0);
	});
}

export async function waitFor(condition: () => boolean, timeout = 5_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms: ${condition}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Mutation helpers that generate ids the way the app does. */
export const make = {
	team(key = "ENG", name = "Engineering"): MutationInput & { name: "team.create" } {
		return { name: "team.create", args: { id: uuidv7(), key, name } };
	},
	issue(teamId: string, title: string, sortOrder = "a0"): MutationInput & { name: "issue.create" } {
		return { name: "issue.create", args: { id: uuidv7(), teamId, title, sortOrder } };
	},
	update(
		issue: Issue,
		patch: Partial<Pick<Issue, "title" | "status" | "priority" | "assigneeId">>,
	) {
		return {
			name: "issue.update",
			args: { id: issue.id, baseVersion: issue.version, patch },
		} satisfies MutationInput;
	},
};

export function issueBy(client: SyncClient, title: string): Issue {
	const issue = [...client.getState().issues.values()].find((i) => i.title === title);
	if (!issue) throw new Error(`No issue titled "${title}"`);
	return issue;
}
