import { PROTOCOL_VERSION } from "@gateweave/track-protocol";
import { expect, it, vi } from "vitest";
import {
	DB_VERSION,
	deleteIdbReplica,
	openIdbPersistence,
	type Persistence,
	SyncClient,
	uuidv7,
} from "../src";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function raw(key: string): Promise<IDBDatabase> {
	return request(indexedDB.open(`track:${key}`));
}

function change() {
	return {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		mutation: {
			name: "team.create" as const,
			args: { id: uuidv7(), key: "ENG", name: "Engineering" },
		},
	};
}

it("discards the local database and its pending store before a fresh start", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	await old.addPending(change());
	old.close();
	await deleteIdbReplica(key);
	const fresh = await openIdbPersistence(key);
	const stored = await fresh.load();
	expect(stored.snapshot).toBeNull();
	expect(stored.pending).toEqual([]);
	expect(stored.unreadable).toEqual([]);
	fresh.close();
});

it("reports a blocked delete and ends the wait after ten seconds", async () => {
	const key = crypto.randomUUID();
	const blocker = await raw(key);
	const onBlocked = vi.fn();
	const deleting = deleteIdbReplica(key, { onBlocked });
	await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledOnce());
	await expect(deleting).rejects.toThrow("Discard timed out");
	blocker.close();
}, 15_000);

it("clears a real stored snapshot while keeping ordered pending rows and client id", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	const clientId = (await old.load()).clientId;
	await old.replace({
		version: 5,
		teams: [],
		statuses: [],
		issues: [],
		labels: [],
		projects: [],
		projectUpdates: [],
		cycles: [],
		comments: [],
		activities: [],
		proposals: [],
		relations: [],
		views: [],
		templates: [],
		members: [],
		subscriptions: [],
		inbox: [],
		pullRequests: [],
		sources: [],
		signals: [],
	});
	const first = change();
	const second = change();
	await old.addPending(first, second);
	old.close();
	// #331 had this row shape but no pendingFormat marker.
	const legacy = await raw(key);
	expect(await request(legacy.transaction("meta").objectStore("meta").get("version"))).toBe(5);
	await request(
		legacy.transaction("meta", "readwrite").objectStore("meta").delete("pendingFormat"),
	);
	legacy.close();
	const next = await openIdbPersistence(key, { version: DB_VERSION + 1 });
	const stored = await next.load();
	expect(stored.clientId).toBe(clientId);
	expect(stored.pending).toEqual([first, second]);
	expect(stored.snapshot).toBeNull();
	next.close();
});

it("records the explicit pending format on a new database and preserves it on upgrade", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	old.close();
	const first = await raw(key);
	expect(await request(first.transaction("meta").objectStore("meta").get("pendingFormat"))).toBe(1);
	await request(first.transaction("meta", "readwrite").objectStore("meta").delete("pendingFormat"));
	first.close();
	const next = await openIdbPersistence(key, { version: DB_VERSION + 1 });
	next.close();
	const upgraded = await raw(key);
	expect(await request(upgraded.transaction("meta").objectStore("meta").get("pendingFormat"))).toBe(
		1,
	);
	upgraded.close();
});

it("repairs a missing format marker on a same-version load", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	storage.close();
	const db = await raw(key);
	await request(db.transaction("meta", "readwrite").objectStore("meta").delete("pendingFormat"));
	db.close();
	const reopened = await openIdbPersistence(key);
	await reopened.load();
	reopened.close();
	const checked = await raw(key);
	expect(await request(checked.transaction("meta").objectStore("meta").get("pendingFormat"))).toBe(
		1,
	);
	checked.close();
});

it("reports an object format marker that cannot be converted to text", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	storage.close();
	const db = await raw(key);
	await request(
		db
			.transaction("meta", "readwrite")
			.objectStore("meta")
			.put({ toString: null, valueOf: null }, "pendingFormat"),
	);
	db.close();
	await expect(openIdbPersistence(key, { version: DB_VERSION + 1 })).rejects.toMatchObject({
		name: "PendingFormatError",
	});
});

it("handles a rejected upgrade metadata request while leaving the old database intact", async () => {
	const key = crypto.randomUUID();
	const opening = indexedDB.open(`track:${key}`, DB_VERSION);
	opening.onupgradeneeded = () => {
		const meta = opening.result.createObjectStore("meta");
		meta.put(1, "other");
		opening.result.createObjectStore("pending", { keyPath: "seq", autoIncrement: true });
	};
	const old = await request(opening);
	old.close();
	const put = IDBObjectStore.prototype.put;
	const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey,
	) {
		return key === "pendingFormat" ? this.add(value, "other") : put.call(this, value, key);
	});
	try {
		await expect(openIdbPersistence(key, { version: DB_VERSION + 1 })).rejects.toThrow();
	} finally {
		spy.mockRestore();
	}
	const unchanged = await raw(key);
	expect(unchanged.version).toBe(DB_VERSION);
	unchanged.close();
});

it("quarantines a row without an id while preserving the rest of the queue", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	const valid = change();
	await storage.addPending(valid);
	storage.close();
	const db = await raw(key);
	const seq = await request(
		db
			.transaction("pending", "readwrite")
			.objectStore("pending")
			.add({
				mutation: { name: "old.change", args: {} },
				createdAt: Date.now(),
			}),
	);
	if (typeof seq !== "number") throw new Error("Expected an auto-increment key");
	db.close();
	const reopened = await openIdbPersistence(key);
	const read = await reopened.load();
	expect(read.pending).toEqual([valid]);
	expect(read.unreadable).toEqual([{ seq, name: "old.change", args: {} }]);
	expect(await reopened.removePending(seq)).toBe(true);
	expect((await reopened.load()).unreadable).toEqual([]);
	reopened.close();
});

it("restores schema defaults before replaying a stored pending change", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	storage.close();
	const db = await raw(key);
	const row = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		mutation: {
			name: "issue.create",
			args: {
				id: uuidv7(),
				teamId: uuidv7(),
				title: "A stored issue",
				sortOrder: "a",
			},
		},
	};
	await request(db.transaction("pending", "readwrite").objectStore("pending").add(row));
	db.close();
	const reopened = await openIdbPersistence(key);
	const stored = await reopened.load();
	expect(stored.pending[0]?.mutation).toMatchObject({
		name: "issue.create",
		args: { labelIds: [] },
	});
	reopened.close();
});

it("syncs readable changes around an unreadable row in order", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	const first = change();
	await storage.addPending(first);
	await storage.replace({
		version: 7,
		teams: [],
		statuses: [],
		issues: [],
		labels: [],
		projects: [],
		projectUpdates: [],
		cycles: [],
		comments: [],
		activities: [],
		proposals: [],
		relations: [],
		views: [],
		templates: [],
		members: [],
		subscriptions: [],
		inbox: [],
		pullRequests: [],
		sources: [],
		signals: [],
	});
	storage.close();
	const db = await raw(key);
	await request(
		db
			.transaction("pending", "readwrite")
			.objectStore("pending")
			.add({
				mutation: { name: "old.change", args: {} },
				createdAt: Date.now(),
			}),
	);
	db.close();
	const after = await openIdbPersistence(key);
	const last = change();
	await after.addPending(last);
	after.close();
	const onReject = vi.fn();
	const sent: string[] = [];
	const client = new SyncClient({
		userId: "bob",
		persistence: openIdbPersistence(key),
		onReject,
		transport: {
			snapshot: async () => {
				throw new Error("Stored snapshot should be used");
			},
			probe: async () => {},
			connect: (handlers) => {
				queueMicrotask(() => handlers.open());
				return {
					close() {},
					send(data) {
						const message = JSON.parse(data);
						if (message.type === "hello")
							handlers.message(JSON.stringify({ type: "ready", version: 7 }));
						if (message.type === "mutate") sent.push(message.id);
					},
				};
			},
		},
	});
	await vi.waitFor(() => expect(onReject).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(sent).toEqual([first.id, last.id]));
	expect(client.getStatus()).toMatchObject({ connection: "live", loaded: true });
	expect(client.getState().version).toBe(7);
	await client.close();
});

it("quarantines an old mutation shape before optimistic replay or resend", async () => {
	const key = crypto.randomUUID();
	const storage = await openIdbPersistence(key);
	storage.close();
	const malformed = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		mutation: {
			name: "issue.update",
			args: { id: "issue-a", baseVersion: 1 },
		},
	};
	const malformedInbox = {
		id: crypto.randomUUID(),
		createdAt: Date.now(),
		mutation: { name: "inbox.update", args: {} },
	};
	const db = await raw(key);
	const pending = db.transaction("pending", "readwrite").objectStore("pending");
	await request(pending.add(malformed));
	await request(pending.add(malformedInbox));
	db.close();
	const sent: unknown[] = [];
	const client = new SyncClient({
		userId: "bob",
		persistence: openIdbPersistence(key),
		transport: {
			snapshot: async () => ({
				version: 0,
				teams: [],
				statuses: [],
				issues: [],
				labels: [],
				projects: [],
				projectUpdates: [],
				cycles: [],
				comments: [],
				activities: [],
				proposals: [],
				relations: [],
				views: [],
				templates: [],
				members: [],
				subscriptions: [],
				inbox: [],
				pullRequests: [],
				sources: [],
				signals: [],
			}),
			probe: async () => {},
			connect: (handlers) => {
				queueMicrotask(() => handlers.open());
				return {
					close() {},
					send(data) {
						const message = JSON.parse(data);
						if (message.type === "hello")
							handlers.message(JSON.stringify({ type: "ready", version: 0 }));
						else sent.push(message);
					},
				};
			},
		},
	});
	await vi.waitFor(() => expect(client.getStatus().connection).toBe("live"));
	expect(client.getStatus().pending).toBe(0);
	expect(() => client.getState()).not.toThrow();
	expect(sent).toHaveLength(0);
	await client.close();
	const reopened = await openIdbPersistence(key);
	expect((await reopened.load()).unreadable).toEqual([]);
	reopened.close();
});

it("aborts an unknown pending format without changing the old database or losing rows", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	await old.load();
	const original = change();
	await old.addPending(original);
	old.close();
	const db = await raw(key);
	await request(db.transaction("meta", "readwrite").objectStore("meta").put(99, "pendingFormat"));
	db.close();
	await expect(openIdbPersistence(key, { version: DB_VERSION + 1 })).rejects.toThrow(
		"cannot read changes",
	);
	const unchanged = await raw(key);
	expect(unchanged.version).toBe(DB_VERSION);
	expect(
		(await request(unchanged.transaction("pending").objectStore("pending").getAll())).map(
			(row) => row.id,
		),
	).toEqual([original.id]);
	unchanged.close();
});

it("reports an unknown pending format through the client's refusal callback", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	await old.load();
	old.close();
	const db = await raw(key);
	await request(db.transaction("meta", "readwrite").objectStore("meta").put(99, "pendingFormat"));
	db.close();
	const onReject = vi.fn();
	const client = new SyncClient({
		userId: "bob",
		persistence: openIdbPersistence(key, { version: DB_VERSION + 1 }),
		onReject,
		transport: {
			snapshot: async () => {
				throw new Error("Must not sync");
			},
			probe: async () => {},
			connect: () => ({ send() {}, close() {} }),
		},
	});
	await vi.waitFor(() => expect(onReject).toHaveBeenCalledOnce());
	expect(onReject.mock.calls[0]?.[0]).toMatchObject({
		storedUnreadable: true,
		mutation: { name: "Stored changes" },
	});
	expect(client.getStatus().connection).toBe("unreadable");
	await client.close();
});

it("reports an unreadable stored row through onReject with its change name", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	await old.load();
	const original = change();
	await old.addPending(original);
	old.close();
	const db = await raw(key);
	await request(
		db
			.transaction("pending", "readwrite")
			.objectStore("pending")
			.put({ ...original, seq: 1, mutation: { name: "retired.change", args: null } }),
	);
	db.close();
	const onReject = vi.fn();
	const client = new SyncClient({
		userId: "bob",
		persistence: openIdbPersistence(key),
		onReject,
		transport: {
			snapshot: async () => ({
				version: 0,
				teams: [],
				statuses: [],
				issues: [],
				labels: [],
				projects: [],
				projectUpdates: [],
				cycles: [],
				comments: [],
				activities: [],
				proposals: [],
				relations: [],
				views: [],
				templates: [],
				members: [],
				subscriptions: [],
				inbox: [],
				pullRequests: [],
				sources: [],
				signals: [],
			}),
			probe: async () => {},
			connect: () => ({ send() {}, close() {} }),
		},
	});
	await vi.waitFor(() => expect(onReject).toHaveBeenCalledOnce());
	expect(onReject.mock.calls[0]?.[0]).toMatchObject({
		storedUnreadable: true,
		mutation: { name: "retired.change" },
	});
	await client.close();
});

it("drains queued writes before an old tab closes on versionchange", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key);
	let releaseWrite = () => {};
	const writeGate = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const persistence: Persistence = {
		shared: true,
		load: () => old.load(),
		replace: (snapshot) => old.replace(snapshot),
		applyOps: (ops, version) => old.applyOps(ops, version),
		addPending: async (...changes) => {
			await writeGate;
			await old.addPending(...changes);
		},
		removePending: (id) => old.removePending(id),
		close: () => old.close(),
		onTaken: (listener) =>
			old.onTaken?.(() => {
				listener();
				setTimeout(releaseWrite, 20);
			}),
	};
	const client = new SyncClient({
		userId: "bob",
		persistence,
		transport: {
			snapshot: async () => ({
				version: 0,
				teams: [],
				statuses: [],
				issues: [],
				labels: [],
				projects: [],
				projectUpdates: [],
				cycles: [],
				comments: [],
				activities: [],
				proposals: [],
				relations: [],
				views: [],
				templates: [],
				members: [],
				subscriptions: [],
				inbox: [],
				pullRequests: [],
				sources: [],
				signals: [],
			}),
			probe: async () => {},
			connect: () => ({ send() {}, close() {} }),
		},
	});
	await vi.waitFor(() => expect(client.getStatus().loaded).toBe(true));
	void client.mutate(change().mutation);
	const next = await openIdbPersistence(key, { version: DB_VERSION + 1 });
	expect((await next.load()).pending).toHaveLength(1);
	expect(client.getStatus().connection).toBe("outdated");
	expect(() => client.mutate(change().mutation)).toThrow("taken over");
	next.close();
	await client.close();
});

it("keeps #331's protocol upgrade behavior", async () => {
	const key = crypto.randomUUID();
	const old = await openIdbPersistence(key, { version: (PROTOCOL_VERSION - 1) * 1000 + 1 });
	await old.load();
	const original = change();
	await old.addPending(original);
	old.close();
	const next = await openIdbPersistence(key);
	expect((await next.load()).pending).toEqual([original]);
	next.close();
});
