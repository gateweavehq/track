import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgetAllWorkspaces,
	forgetKnownWorkspace,
	isUnreachable,
	type KnownWorkspace,
	knownWorkspace,
	lastWorkspace,
	OfflineError,
	rememberWorkspace,
	withOfflineFallback,
} from "./offline";

const acme: KnownWorkspace = { id: "ws-acme", name: "Acme", userId: "user-maya", role: "owner" };
const globex: KnownWorkspace = {
	id: "ws-globex",
	name: "Globex",
	userId: "user-maya",
	role: "member",
};

/** What fetch rejects with in Chrome when the server cannot be reached. */
const unreachable = () => new TypeError("Failed to fetch");

beforeEach(() => {
	const items = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	});
	vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isUnreachable", () => {
	it("tells a missing response from a refusal or a bug", () => {
		expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(true);
		expect(isUnreachable(new TypeError("NetworkError when attempting to fetch resource."))).toBe(
			true,
		);
		expect(isUnreachable(new TypeError("Load failed"))).toBe(true);
		expect(isUnreachable(new OfflineError())).toBe(true);

		expect(isUnreachable(new TypeError("Cannot read properties of undefined"))).toBe(false);
		expect(isUnreachable(new Error("Unauthorized"))).toBe(false);
	});

	it("counts any failure as unreachable while the browser says it is offline", () => {
		vi.stubGlobal("navigator", { onLine: false });
		expect(isUnreachable(new Error("anything"))).toBe(true);
	});
});

describe("withOfflineFallback", () => {
	it("uses the server's answer whenever there is one, even an empty one", async () => {
		const fallback = vi.fn(() => acme);
		expect(await withOfflineFallback(async () => globex, fallback)).toBe(globex);
		expect(await withOfflineFallback(async () => null, fallback)).toBeNull();
		expect(fallback).not.toHaveBeenCalled();
	});

	it("falls back to the device only when the server cannot be reached", async () => {
		await expect(
			withOfflineFallback(
				() => Promise.reject(unreachable()),
				() => acme,
			),
		).resolves.toBe(acme);
		await expect(
			withOfflineFallback(
				() => Promise.reject(new Error("Forbidden")),
				() => acme,
			),
		).rejects.toThrow("Forbidden");
	});

	it("reports being offline when the device has nothing either", async () => {
		await expect(
			withOfflineFallback(
				() => Promise.reject(unreachable()),
				() => undefined,
			),
		).rejects.toBeInstanceOf(OfflineError);
	});
});

describe("remembered workspaces", () => {
	it("knows the workspaces opened here, and which one was last", () => {
		rememberWorkspace("acme", acme);
		rememberWorkspace("globex", globex);

		expect(knownWorkspace("acme")).toEqual(acme);
		expect(knownWorkspace("globex")).toEqual(globex);
		expect(knownWorkspace("initech")).toBeUndefined();
		expect(lastWorkspace()).toBe("globex");
	});

	it("forgets another account's workspaces when someone else signs in", () => {
		rememberWorkspace("acme", acme);
		rememberWorkspace("globex", { ...globex, userId: "user-sam" });

		expect(knownWorkspace("acme")).toBeUndefined();
		expect(knownWorkspace("globex")?.userId).toBe("user-sam");
	});

	it("forgets a workspace by slug, or by id under every slug it had", () => {
		rememberWorkspace("acme", acme);
		rememberWorkspace("acme-corp", acme);
		rememberWorkspace("globex", globex);

		forgetKnownWorkspace({ id: acme.id });
		expect(knownWorkspace("acme")).toBeUndefined();
		expect(knownWorkspace("acme-corp")).toBeUndefined();
		expect(lastWorkspace()).toBe("globex");

		forgetKnownWorkspace({ slug: "globex" });
		expect(knownWorkspace("globex")).toBeUndefined();
		expect(lastWorkspace()).toBeUndefined();
	});

	it("forgets everything on sign-out", () => {
		rememberWorkspace("acme", acme);
		forgetAllWorkspaces();
		expect(knownWorkspace("acme")).toBeUndefined();
		expect(lastWorkspace()).toBeUndefined();
	});

	it("keeps working without storage, remembering nothing", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("SecurityError");
			},
			removeItem: () => {
				throw new Error("SecurityError");
			},
		});
		expect(() => rememberWorkspace("acme", acme)).not.toThrow();
		expect(knownWorkspace("acme")).toBeUndefined();
		expect(() => forgetAllWorkspaces()).not.toThrow();
	});
});
