import { expect, it, vi } from "vitest";
import { SyncClient } from "../src/client";
import { MemoryPersistence, PendingFormatError, type Persistence } from "../src/persistence";
import type { TabMessage, Tabs } from "../src/tabs";

const empty = {
	version: 1,
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
};

function change() {
	return {
		name: "team.create" as const,
		args: { id: crypto.randomUUID(), key: "ENG", name: "Engineering" },
	};
}

function controls() {
	let taken = () => {};
	let leader = () => {};
	let receive = (_message: TabMessage) => {};
	const post = vi.fn();
	const tabs: Tabs = {
		elect: (callback) => {
			leader = callback;
		},
		post,
		subscribe: (callback) => {
			receive = callback;
		},
		close() {},
	};
	const memory = new MemoryPersistence();
	const persistence: Persistence = {
		shared: true,
		load: () => memory.load(),
		replace: (snapshot) => memory.replace(snapshot),
		applyOps: (ops, version) => memory.applyOps(ops, version),
		addPending: (...changes) => memory.addPending(...changes),
		removePending: (id) => memory.removePending(id),
		onTaken: (callback) => {
			taken = callback;
		},
		close() {},
	};
	const connect = vi.fn(() => ({ send() {}, close() {} }));
	const transport = { snapshot: async () => empty, probe: async () => {}, connect };
	return {
		persistence,
		tabs,
		post,
		connect,
		transport,
		take: () => taken(),
		lead: () => leader(),
		receive: (message: TabMessage) => receive(message),
	};
}

it("rejects an edit accepted during startup when stored changes cannot be read", async () => {
	const c = controls();
	let fail = () => {};
	const gate = new Promise<never>((_resolve, reject) => {
		fail = () => reject(new PendingFormatError(99));
	});
	c.persistence.load = () => gate;
	const client = new SyncClient({ userId: "bob", ...c, persistence: c.persistence });
	const answer = client.mutate(change());
	fail();
	await expect(answer).rejects.toMatchObject({ reason: "invalid" });
	expect(client.getStatus().connection).toBe("unreadable");
	await client.close();
});

it("keeps a taken follower outdated when a late live status arrives", async () => {
	const c = controls();
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	c.take();
	c.receive({ type: "status", connection: "live" });
	expect(client.getStatus().connection).toBe("outdated");
	await client.close();
});

it("shows the reload prompt when takeover follows an unreadable status", async () => {
	const c = controls();
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	c.receive({ type: "status", connection: "unreadable" });
	expect(client.getStatus().connection).toBe("unreadable");
	c.take();
	expect(client.getStatus().connection).toBe("outdated");
	await client.close();
});

it("ignores a failed follower reload after storage takeover", async () => {
	const c = controls();
	const onReject = vi.fn();
	let failLoad = () => {};
	const failed = new Promise<never>((_resolve, reject) => {
		failLoad = () => reject(new PendingFormatError(99));
	});
	const load = c.persistence.load.bind(c.persistence);
	let reads = 0;
	c.persistence.load = () => (++reads === 1 ? load() : failed);
	const client = new SyncClient({ userId: "bob", ...c, onReject });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	c.receive({ type: "reload" });
	await vi.waitFor(() => expect(reads).toBe(2));
	c.take();
	failLoad();
	await vi.waitFor(() => expect(client.getStatus().connection).toBe("outdated"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(onReject).not.toHaveBeenCalled();
	await client.close();
});

it("leaves remaining unreadable rows for the new owner after takeover", async () => {
	const c = controls();
	const load = c.persistence.load.bind(c.persistence);
	c.persistence.load = async () => ({
		...(await load()),
		unreadable: [
			{ id: "first", name: "old.change", args: {} },
			{ id: "second", name: "old.change", args: {} },
		],
	});
	let finish = () => {};
	const removing = new Promise<boolean>((resolve) => {
		finish = () => resolve(true);
	});
	c.persistence.removePending = vi.fn(() => removing);
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	c.lead();
	await vi.waitFor(() => expect(c.persistence.removePending).toHaveBeenCalledWith("first"));
	c.take();
	finish();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await client.close();
	expect(c.persistence.removePending).toHaveBeenCalledTimes(1);
});

it("settles unconfirmed edits on takeover without removing their stored rows", async () => {
	const c = controls();
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	const answer = client.mutate(change());
	c.take();
	await expect(answer).rejects.toThrow("not confirmed");
	await client.close();
	expect((await c.persistence.load()).pending).toHaveLength(1);
});

it("does not elect or connect after takeover during a pending load", async () => {
	const c = controls();
	const load = c.persistence.load.bind(c.persistence);
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	c.persistence.load = async () => {
		await gate;
		return load();
	};
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.persistence.onTaken).toBeDefined());
	c.take();
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	c.lead();
	expect(c.connect).not.toHaveBeenCalled();
	expect(c.post).not.toHaveBeenCalledWith({ type: "status?" });
	expect(client.getStatus().connection).toBe("outdated");
	await client.close();
});

it("ignores a leadership callback delivered after takeover", async () => {
	const c = controls();
	const client = new SyncClient({ userId: "bob", ...c });
	await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
	c.take();
	c.lead();
	expect(c.connect).not.toHaveBeenCalled();
	expect(client.getStatus().connection).toBe("outdated");
	await client.close();
});

it("reports unreadable rows only when removal succeeds or aborts, broadcasting only a commit", async () => {
	for (const outcome of [true, false, "abort"] as const) {
		const c = controls();
		const onReject = vi.fn();
		const load = c.persistence.load.bind(c.persistence);
		c.persistence.load = async () => ({
			...(await load()),
			unreadable: [{ id: "bad", name: "old.change", args: {} }],
		});
		c.persistence.removePending = vi.fn(async () => {
			if (outcome === "abort") throw new Error("aborted");
			return outcome;
		});
		const client = new SyncClient({ userId: "bob", ...c, onReject });
		await vi.waitFor(() => expect(c.post).toHaveBeenCalledWith({ type: "status?" }));
		c.lead();
		await vi.waitFor(() => expect(c.persistence.removePending).toHaveBeenCalledWith("bad"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onReject).toHaveBeenCalledTimes(outcome === false ? 0 : 1);
		expect(c.post.mock.calls.some(([message]) => message.type === "reject")).toBe(outcome === true);
		await client.close();
	}
});
