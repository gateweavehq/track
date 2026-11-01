import { describe, expect, it } from "vitest";
import { memoryOutboxStore, type PendingUpload, UploadOutbox } from "./upload-outbox";

let made = 0;
function upload(name: string, workspaceId = "ws-1", userId = "user-1"): PendingUpload {
	made += 1;
	return {
		path: `/api/files/${workspaceId}/${name}`,
		workspaceId,
		userId,
		name,
		type: "text/plain",
		blob: new Blob([name]),
		createdAt: made,
	};
}

/** A gateway that answers each PUT as `answer` says, or throws as a lost connection does. */
function gateway(answer: (path: string) => number | "offline") {
	const sent: string[] = [];
	const fetch = (async (input: RequestInfo | URL) => {
		const path = String(input);
		sent.push(path);
		const status = answer(path);
		if (status === "offline") throw new TypeError("Failed to fetch");
		const body = status >= 400 ? JSON.stringify({ error: `Refused ${path}` }) : null;
		return new Response(body, { status });
	}) as typeof globalThis.fetch;
	return { fetch, sent };
}

describe("UploadOutbox", () => {
	it("uploads at once when it can, and forgets the file", async () => {
		const store = memoryOutboxStore();
		const { fetch, sent } = gateway(() => 201);
		const outbox = new UploadOutbox({ store, fetch });
		const file = upload("a.txt");

		expect(await outbox.add(file)).toEqual({ status: "uploaded" });
		expect(sent).toEqual([file.path]);
		expect(await store.all()).toEqual([]);
		expect(outbox.pending(file.path).waiting).toBe(false);
	});

	it("keeps files while offline, shows them as waiting, and uploads them in order later", async () => {
		const store = memoryOutboxStore();
		let online = false;
		const { fetch, sent } = gateway(() => (online ? 201 : "offline"));
		const outbox = new UploadOutbox({ store, fetch });
		const first = upload("first.txt");
		const second = upload("second.txt");

		expect(await outbox.add(first)).toEqual({ status: "waiting" });
		expect(await outbox.add(second)).toEqual({ status: "waiting" });
		expect(outbox.pending(first.path).waiting).toBe(true);
		expect(outbox.size).toBe(2);
		// A drain stops at the first file the network refuses rather than trying every one.
		expect(sent.filter((path) => path === second.path).length).toBeLessThanOrEqual(1);

		online = true;
		sent.length = 0;
		const settled: string[] = [];
		outbox.onSettled((file, result, firstTry) =>
			settled.push(`${file.name}: ${result.status}${firstTry ? " (first try)" : ""}`),
		);
		await outbox.drain();
		expect(sent).toEqual([first.path, second.path]);
		// Both waited, so neither is a first try: the page says they went through.
		expect(settled).toEqual(["first.txt: uploaded", "second.txt: uploaded"]);
		expect(outbox.size).toBe(0);
		expect(await store.all()).toEqual([]);
	});

	it("counts a file the server already has as uploaded, as after a retry or from another tab", async () => {
		const outbox = new UploadOutbox({
			store: memoryOutboxStore(),
			fetch: gateway(() => 409).fetch,
		});
		expect(await outbox.add(upload("twice.txt"))).toEqual({ status: "uploaded" });
		expect(outbox.size).toBe(0);
	});

	it("keeps a file the server cannot take now, and drops one it refuses for good", async () => {
		const store = memoryOutboxStore();
		const outbox = new UploadOutbox({
			store,
			fetch: gateway((path) => (path.endsWith("busy.txt") ? 503 : 413)).fetch,
		});

		expect(await outbox.add(upload("busy.txt"))).toEqual({ status: "waiting" });
		const big = upload("big.bin");
		await store.put(big);
		const results: string[] = [];
		outbox.onSettled((file, result) => results.push(`${file.name}: ${result.status}`));
		await outbox.drain();
		// The busy one is first and stops the drain; the big one waits behind it.
		expect(results).toEqual(["busy.txt: waiting", "big.bin: waiting"]);

		const refusing = new UploadOutbox({
			store: memoryOutboxStore(),
			fetch: gateway(() => 413).fetch,
		});
		expect(await refusing.add(upload("huge.bin"))).toEqual({
			status: "failed",
			message: "Refused /api/files/ws-1/huge.bin.",
		});
		expect(refusing.size).toBe(0);
	});

	it("keeps a file waiting while the session has run out, and uploads it after signing in", async () => {
		const store = memoryOutboxStore();
		let signedIn = false;
		const { fetch } = gateway(() => (signedIn ? 201 : 401));
		const outbox = new UploadOutbox({ store, fetch });
		const file = upload("screenshot.png");

		expect(await outbox.add(file)).toEqual({ status: "waiting" });
		expect(await store.all()).toEqual([file]);
		expect(outbox.pending(file.path).waiting).toBe(true);

		signedIn = true;
		await outbox.drain();
		expect(await store.all()).toEqual([]);
		expect(outbox.pending(file.path).waiting).toBe(false);
	});

	it("uploads only the signed-in person's files, never under someone else's session", async () => {
		const store = memoryOutboxStore();
		const { fetch, sent } = gateway(() => 201);
		const theirs = upload("theirs.txt", "ws-1", "user-1");
		await store.put(theirs);

		const outbox = new UploadOutbox({ store, fetch });
		outbox.setUser("user-2");
		await outbox.load();
		expect(outbox.pending(theirs.path).waiting).toBe(false);
		await outbox.drain();
		expect(sent).toEqual([]);
		expect(await store.all()).toEqual([theirs]);

		// Back as the person who attached it, it goes up.
		outbox.setUser("user-1");
		await outbox.load();
		expect(outbox.pending(theirs.path).waiting).toBe(true);
		await outbox.drain();
		expect(sent).toEqual([theirs.path]);
		expect(await store.all()).toEqual([]);
	});

	it("picks up what an earlier visit left waiting", async () => {
		const store = memoryOutboxStore();
		const left = upload("left.txt");
		await store.put(left);
		const { fetch, sent } = gateway(() => 201);
		const outbox = new UploadOutbox({ store, fetch });
		outbox.setUser("user-1");
		const settled: boolean[] = [];
		outbox.onSettled((_file, _result, firstTry) => settled.push(firstTry));

		await outbox.load();
		expect(outbox.pending(left.path).waiting).toBe(true);
		await outbox.drain();
		expect(sent).toEqual([left.path]);
		expect(outbox.size).toBe(0);
		// Left by an earlier visit, so not a first try here.
		expect(settled).toEqual([false]);
	});

	it("uploads a file added while a drain is under way", async () => {
		const store = memoryOutboxStore();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sent: string[] = [];
		const fetch = (async (input: RequestInfo | URL) => {
			sent.push(String(input));
			if (sent.length === 1) await held;
			return new Response(null, { status: 201 });
		}) as typeof globalThis.fetch;
		const outbox = new UploadOutbox({ store, fetch });

		const first = outbox.add(upload("first.txt"));
		await Promise.resolve();
		const second = outbox.add(upload("second.txt"));
		release();
		expect(await first).toEqual({ status: "uploaded" });
		expect(await second).toEqual({ status: "uploaded" });
		expect(sent).toEqual(["/api/files/ws-1/first.txt", "/api/files/ws-1/second.txt"]);
	});

	it("forgets one workspace's files, or all of them", async () => {
		const store = memoryOutboxStore();
		const outbox = new UploadOutbox({ store, fetch: gateway(() => "offline").fetch });
		const mine = upload("mine.txt", "ws-1");
		const theirs = upload("theirs.txt", "ws-2");
		await outbox.add(mine);
		await outbox.add(theirs);

		await outbox.clear("ws-1");
		expect(outbox.pending(mine.path).waiting).toBe(false);
		expect(outbox.pending(theirs.path).waiting).toBe(true);
		await outbox.clear();
		expect(outbox.size).toBe(0);
		expect(await store.all()).toEqual([]);
	});
});
