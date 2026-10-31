import { PROTOCOL_VERSION, privateId } from "@gateweave/track-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deleteIdbReplica,
	MemoryPersistence,
	MutationError,
	openIdbPersistence,
	SyncClient,
	type SyncSocket,
	type Transport,
	uuidv7,
} from "../src";
import { issueBy, make, TestWorkspace, waitFor, waitForConvergence, waitForLive } from "./harness";

let workspace: TestWorkspace;

afterEach(async () => {
	await workspace?.close();
});

function setup() {
	workspace = new TestWorkspace();
	return workspace;
}

describe("connecting", () => {
	it("loads a snapshot, then goes live", async () => {
		const ws = setup();
		const alice = ws.client("alice");
		expect(alice.getStatus()).toMatchObject({ connection: "connecting", loaded: false });

		await waitForLive(alice);
		expect(alice.getStatus().loaded).toBe(true);
		expect(alice.getState().members.get("alice")).toMatchObject({ name: "Alice", role: "owner" });
	});

	it("catches up on changes made while it was away", async () => {
		const ws = setup();
		const persistence = new MemoryPersistence();
		const first = await ws.live("alice", { persistence });
		const { args: team } = make.team();
		await first.mutate({ name: "team.create", args: team });
		await first.close();

		const bob = await ws.live("bob");
		await bob.mutate(make.issue(team.id, "Written while Alice was away"));

		const network = ws.network("alice");
		const again = await ws.live("alice", { persistence, network });
		expect(issueBy(again, "Written while Alice was away").number).toBe(1);
		// Caught up from the oplog, not from a new snapshot.
		expect(network.snapshots).toBe(0);
	});
});

describe("mutations", () => {
	it("applies optimistically, then confirms", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const create = make.team("ENG", "Engineering");

		const confirmed = alice.mutate(create);
		// Visible before the server has seen it.
		expect(alice.getState().teams.get(create.args.id)?.name).toBe("Engineering");
		expect(alice.getStatus().pending).toBe(1);

		const version = await confirmed;
		expect(alice.getState().version).toBeGreaterThanOrEqual(version);
		await waitFor(() => alice.getStatus().pending === 0);
		expect(alice.getState().teams.get(create.args.id)?.key).toBe("ENG");
	});

	it("replaces predictions with the server's result", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const bob = await ws.live("bob");
		const team = make.team();
		await alice.mutate(team);
		await waitForConvergence(alice, bob);

		// Both predict ENG-1 for their own issue; the server gives one of them ENG-2.
		const a = alice.mutate(make.issue(team.args.id, "From Alice"));
		const b = bob.mutate(make.issue(team.args.id, "From Bob"));
		expect(issueBy(alice, "From Alice").number).toBe(1);
		expect(issueBy(bob, "From Bob").number).toBe(1);
		await Promise.all([a, b]);
		await waitForConvergence(alice, bob);

		const numbers = [issueBy(alice, "From Alice").number, issueBy(alice, "From Bob").number];
		expect(numbers.sort()).toEqual([1, 2]);
		expect(issueBy(bob, "From Alice")).toEqual(issueBy(alice, "From Alice"));
	});

	it("rolls back and reports a rejected mutation", async () => {
		const ws = setup();
		const onReject = vi.fn();
		const bob = await ws.live("bob", { onReject });
		const team = make.team();

		// Members cannot create teams.
		const result = bob.mutate(team);
		expect(bob.getState().teams.has(team.args.id)).toBe(true);

		await expect(result).rejects.toMatchObject({ name: "MutationError", reason: "forbidden" });
		expect(bob.getState().teams.has(team.args.id)).toBe(false);
		expect(bob.getStatus().pending).toBe(0);
		expect(onReject).toHaveBeenCalledOnce();
		expect(onReject.mock.calls[0]?.[0]).toBeInstanceOf(MutationError);
	});

	it("rolls back an issue's project when the project was deleted meanwhile", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const network = ws.network("bob");
		const bob = await ws.live("bob", { network });
		const team = make.team();
		const project = {
			name: "project.create",
			args: { id: uuidv7(), name: "Launch" },
		} as const;
		await alice.mutate(team);
		await alice.mutate(make.issue(team.args.id, "Plan"));
		await alice.mutate(project);
		await waitForConvergence(alice, bob);
		const plan = issueBy(bob, "Plan");

		network.offline();
		await waitFor(() => bob.getStatus().connection === "offline");
		const result = bob.mutate({
			name: "issue.update",
			args: { id: plan.id, baseVersion: plan.version, patch: { projectId: project.args.id } },
		});
		expect(issueBy(bob, "Plan").projectId).toBe(project.args.id);

		await alice.mutate({ name: "project.delete", args: { id: project.args.id } });
		network.online();

		await expect(result).rejects.toMatchObject({ name: "MutationError", reason: "not_found" });
		await waitForConvergence(alice, bob);
		for (const client of [alice, bob]) {
			expect(client.getState().projects.size).toBe(0);
			expect(issueBy(client, "Plan").projectId).toBeNull();
		}
	});

	it("validates input before queueing it", async () => {
		const ws = setup();
		const alice = ws.client("alice");
		expect(() =>
			alice.mutate({ name: "team.create", args: { id: "x", key: "lowercase", name: "Bad" } }),
		).toThrow();
		expect(alice.getStatus().pending).toBe(0);
	});
});

describe("collaboration", () => {
	it("streams changes between users", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const bob = await ws.live("bob");
		const team = make.team();
		await alice.mutate(team);
		await bob.mutate(make.issue(team.args.id, "Bob's issue"));

		await waitFor(() => alice.getState().issues.size === 1);
		expect(issueBy(alice, "Bob's issue").creatorId).toBe("bob");
	});

	it("merges concurrent edits to different fields", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const bob = await ws.live("bob");
		const team = make.team();
		await alice.mutate(team);
		await alice.mutate(make.issue(team.args.id, "Shared"));
		await waitForConvergence(alice, bob);

		const seenByAlice = issueBy(alice, "Shared");
		const seenByBob = issueBy(bob, "Shared");
		await Promise.all([
			alice.mutate(make.update(seenByAlice, { title: "Shared, renamed" })),
			bob.mutate(make.update(seenByBob, { status: "in_progress" })),
		]);
		await waitForConvergence(alice, bob);

		for (const client of [alice, bob]) {
			expect(client.getState().issues.get(seenByAlice.id)).toMatchObject({
				title: "Shared, renamed",
				status: "in_progress",
			});
		}
	});
});

describe("inbox", () => {
	it("keeps each member's subscriptions and inbox to themselves", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const bob = await ws.live("bob");
		const team = make.team();
		await alice.mutate(team);
		const issue = { ...make.issue(team.args.id, "For Bob") };
		await alice.mutate({ ...issue, args: { ...issue.args, assigneeId: "bob" } });
		await waitForConvergence(alice, bob);

		const id = privateId(issue.args.id, "bob");
		const item = bob.getState().inbox.get(id);
		expect(item).toMatchObject({ event: { type: "assigned" }, actorId: "alice", unread: 1 });
		expect([...bob.getState().subscriptions.keys()]).toEqual([id]);
		expect(alice.getState().inbox.size).toBe(0);
		expect([...alice.getState().subscriptions.keys()]).toEqual([privateId(issue.args.id, "alice")]);

		// Reading it is Bob's alone: Alice hears nothing, and her next change still reaches him.
		const before = alice.getState().version;
		await bob.mutate({
			name: "inbox.update",
			args: {
				items: [{ issueId: issue.args.id, seen: item?.updatedAt ?? 0 }],
				patch: { read: true },
			},
		});
		expect(bob.getState().inbox.get(id)?.unread).toBe(0);
		expect(bob.getState().version).toBeGreaterThan(before);
		expect(alice.getState().version).toBe(before);

		await alice.mutate(make.update(issueBy(alice, "For Bob"), { status: "todo" }));
		await waitForConvergence(alice, bob);
		expect(bob.getState().inbox.get(id)).toMatchObject({
			event: { type: "status", from: "backlog", to: "todo" },
			unread: 1,
		});
		expect(alice.getState().inbox.size).toBe(0);
	});
});

describe("offline", () => {
	it("queues edits while offline and merges them on reconnect", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const network = ws.network("bob");
		const bob = await ws.live("bob", { network });
		const team = make.team();
		await alice.mutate(team);
		await alice.mutate(make.issue(team.args.id, "Plan"));
		await waitForConvergence(alice, bob);
		const plan = issueBy(bob, "Plan");

		network.offline();
		await waitFor(() => bob.getStatus().connection === "offline");

		// Bob works offline: a new issue, an edit to it, and edits to a shared issue.
		const created = make.issue(team.args.id, "Offline idea");
		const results = [
			bob.mutate(created),
			bob.mutate({
				name: "issue.update",
				args: { id: created.args.id, baseVersion: 0, patch: { priority: 1 } },
			}),
			bob.mutate(make.update(plan, { status: "done" })),
			bob.mutate(make.update(plan, { title: "Bob's title" })),
		];
		expect(issueBy(bob, "Offline idea").priority).toBe(1);
		expect(bob.getStatus().pending).toBe(4);

		// Meanwhile Alice changes the title of the shared issue, which Bob's later edit conflicts with.
		await alice.mutate(make.update(issueBy(alice, "Plan"), { title: "Alice's title" }));

		network.online();
		const settled = await Promise.allSettled(results);
		expect(settled.map((r) => r.status)).toEqual([
			"fulfilled",
			"fulfilled",
			"fulfilled",
			"rejected",
		]);
		expect((settled[3] as PromiseRejectedResult).reason).toMatchObject({ reason: "conflict" });

		await waitForConvergence(alice, bob);
		for (const client of [alice, bob]) {
			expect(client.getState().issues.get(plan.id)).toMatchObject({
				title: "Alice's title",
				status: "done",
			});
			expect(issueBy(client, "Offline idea")).toMatchObject({ priority: 1, number: 2 });
		}
	});

	it("keeps unsent edits across a reload", async () => {
		const ws = setup();
		const key = `reload-${ws.id}`;
		const alice = await ws.live("alice");
		const team = make.team();
		await alice.mutate(team);

		const network = ws.network("bob");
		const bob = await ws.live("bob", { network, persistence: openIdbPersistence(key) });
		network.offline();
		await waitFor(() => bob.getStatus().connection === "offline");
		void bob.mutate(make.issue(team.args.id, "Survives the reload"));
		await bob.close();

		// The reopened tab shows the edit straight from storage, before reaching the server.
		const offline = ws.network("bob");
		offline.offline();
		const reopened = ws.client("bob", { network: offline, persistence: openIdbPersistence(key) });
		await waitFor(() => reopened.getStatus().loaded);
		expect(issueBy(reopened, "Survives the reload").number).toBe(1);
		expect(reopened.getStatus().pending).toBe(1);
		await reopened.close();

		const online = ws.network("bob");
		const synced = await ws.live("bob", { network: online, persistence: openIdbPersistence(key) });
		await waitForConvergence(synced, alice);
		expect(issueBy(alice, "Survives the reload").creatorId).toBe("bob");
		expect(online.snapshots).toBe(0);
	});

	it("forgets a workspace whose replica was deleted", async () => {
		const ws = setup();
		const key = `forget-${ws.id}`;
		const other = `keep-${ws.id}`;
		const alice = await ws.live("alice", { persistence: openIdbPersistence(key) });
		const kept = await ws.live("alice", { persistence: openIdbPersistence(other) });
		await alice.mutate(make.team());
		await waitForConvergence(alice, kept);
		await alice.close();
		await kept.close();

		await deleteIdbReplica(key);

		// Offline, a reopened client can only show what storage still holds.
		const reopen = async (storageKey: string) => {
			const network = ws.network("alice");
			network.offline();
			const client = ws.client("alice", { network, persistence: openIdbPersistence(storageKey) });
			await waitFor(() => client.getStatus().connection === "offline");
			return client;
		};
		const forgotten = await reopen(key);
		expect(forgotten.getStatus().loaded).toBe(false);
		expect(forgotten.getState().teams.size).toBe(0);
		await forgotten.close();

		const untouched = await reopen(other);
		await waitFor(() => untouched.getStatus().loaded);
		expect(untouched.getState().teams.size).toBe(1);
		await untouched.close();
	});

	it("starts from a fresh snapshot when the server cannot catch it up", async () => {
		const ws = setup();
		const alice = await ws.live("alice");
		const team = make.team();
		await alice.mutate(team);

		// Storage that claims a version the server never reached, e.g. after a server-side restore.
		const persistence = new MemoryPersistence();
		await persistence.replace({
			version: 9_999,
			teams: [],
			issues: [],
			labels: [],
			projects: [],
			cycles: [],
			comments: [],
			activities: [],
			proposals: [],
			relations: [],
			views: [],
			members: [],
			subscriptions: [],
			inbox: [],
		});
		const network = ws.network("alice");
		const stale = await ws.live("alice", { persistence, network });

		expect(network.snapshots).toBe(1);
		expect(stale.getState().version).toBe(alice.getState().version);
		expect(stale.getState().teams.has(team.args.id)).toBe(true);
	});
});

describe("connection loss", () => {
	it("reconnects after the network comes back", async () => {
		const ws = setup();
		const network = ws.network("alice");
		const alice = await ws.live("alice", { network });

		network.offline();
		await waitFor(() => alice.getStatus().connection === "offline");
		network.online();
		await waitForLive(alice);
		expect(network.sockets).toBe(1);
	});

	it("stops when the user is removed from the workspace", async () => {
		const ws = setup();
		await ws.live("alice");
		const network = ws.network("bob");
		const bob = await ws.live("bob", { network });

		await ws.remove("bob");
		await waitFor(() => bob.getStatus().connection === "forbidden");
		const connects = network.connects;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(network.connects).toBe(connects);
	});

	it("reports a signed-out user instead of retrying forever", async () => {
		const ws = setup();
		const mallory = ws.client("mallory");
		await waitFor(() => mallory.getStatus().connection === "unauthorized");
	});

	it("finds out why a reconnect is refused", async () => {
		const ws = setup();
		await ws.live("alice");
		const network = ws.network("bob");
		const bob = await ws.live("bob", { network });
		network.offline();
		await waitFor(() => bob.getStatus().connection === "offline");

		// Removed while away, so there is no socket to close. The next handshake is refused, and
		// since a WebSocket cannot say why, the client asks the gateway.
		await ws.remove("bob");
		network.online();
		await waitFor(() => bob.getStatus().connection === "forbidden");
	});
});

describe("protocol", () => {
	it("asks for a reload when the server speaks another protocol", async () => {
		const sent: string[] = [];
		const transport = scriptedTransport((socket, message) => {
			sent.push(message);
			socket.close(4001, "Server speaks protocol 2");
		});
		const client = new SyncClient({ userId: "alice", transport, retry: { minDelay: 5 } });
		await waitFor(() => client.getStatus().connection === "outdated");
		expect(JSON.parse(sent[0] ?? "")).toMatchObject({ type: "hello", protocol: PROTOCOL_VERSION });
		await client.close();
	});

	it("treats a connection that stops answering pings as lost", async () => {
		let connects = 0;
		const transport = scriptedTransport(
			(socket, message) => {
				// Completes the handshake but never answers pings.
				if (message.includes('"hello"')) socket.reply({ type: "ready", version: 1 });
			},
			() => connects++,
		);
		const client = new SyncClient({
			userId: "alice",
			transport,
			keepalive: { interval: 20, timeout: 20 },
			retry: { minDelay: 5, maxDelay: 5 },
		});
		await waitFor(() => connects >= 3);
		await client.close();
	});
});

/** A transport whose server is a script, for behavior the real server cannot be made to show. */
function scriptedTransport(
	onMessage: (
		socket: { reply(message: object): void; close(code: number, reason: string): void },
		message: string,
	) => void,
	onConnect: () => void = () => {},
): Transport {
	return {
		snapshot: async () => ({
			version: 1,
			teams: [],
			issues: [],
			labels: [],
			projects: [],
			cycles: [],
			comments: [],
			activities: [],
			proposals: [],
			relations: [],
			views: [],
			members: [],
			subscriptions: [],
			inbox: [],
		}),
		probe: async () => {},
		connect(handlers): SyncSocket {
			onConnect();
			let open = true;
			const server = {
				reply: (message: object) =>
					setTimeout(() => open && handlers.message(JSON.stringify(message))),
				close: (code: number, reason: string) =>
					setTimeout(() => {
						if (!open) return;
						open = false;
						handlers.close(code, reason);
					}),
			};
			setTimeout(() => handlers.open());
			return {
				send: (data) => onMessage(server, data),
				close: () => {
					open = false;
				},
			};
		},
	};
}
