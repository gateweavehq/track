import { describe, expect, it } from "vitest";
import { freshWorkspace } from "./client";

// A workspace's file quota: the object counts the bytes of its attached files so that uploads,
// which pass through it one at a time, cannot together go past the limit.

describe("file storage", () => {
	it("starts counting from what the bucket holds, then reserves until the limit", async () => {
		const workspace = freshWorkspace();
		expect(await workspace.reserveFileStorage({ bytes: 10, limit: 100 })).toEqual({
			needsSeed: true,
		});
		expect(await workspace.reserveFileStorage({ bytes: 10, limit: 100, seed: 60 })).toEqual({
			ok: true,
			used: 70,
		});
		// Once counting, a seed from a slower upload's listing is ignored.
		expect(await workspace.reserveFileStorage({ bytes: 30, limit: 100, seed: 0 })).toEqual({
			ok: true,
			used: 100,
		});
		expect(await workspace.reserveFileStorage({ bytes: 1, limit: 100 })).toEqual({
			ok: false,
			used: 100,
		});
		// A raised limit makes room at once.
		expect(await workspace.reserveFileStorage({ bytes: 1, limit: 200 })).toEqual({
			ok: true,
			used: 101,
		});
	});

	it("gives back what an upload did not store", async () => {
		const workspace = freshWorkspace();
		await workspace.reserveFileStorage({ bytes: 40, limit: 50, seed: 0 });
		expect(await workspace.reserveFileStorage({ bytes: 20, limit: 50 })).toMatchObject({
			ok: false,
		});
		await workspace.releaseFileStorage(40);
		expect(await workspace.reserveFileStorage({ bytes: 20, limit: 50 })).toEqual({
			ok: true,
			used: 20,
		});
		// Never below nothing.
		await workspace.releaseFileStorage(1000);
		expect(await workspace.reserveFileStorage({ bytes: 0, limit: 50 })).toEqual({
			ok: true,
			used: 0,
		});
	});

	it("keeps the count when an upload already went past it", async () => {
		const workspace = freshWorkspace();
		// Files attached before the quota existed can already fill it.
		expect(await workspace.reserveFileStorage({ bytes: 5, limit: 50, seed: 80 })).toEqual({
			ok: false,
			used: 80,
		});
		expect(await workspace.reserveFileStorage({ bytes: 5, limit: 50 })).toEqual({
			ok: false,
			used: 80,
		});
	});
});
