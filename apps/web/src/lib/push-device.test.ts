import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPushOn, pushIsOn, turnPushOff, turnPushOn } from "./push-device";
import { toBase64Url } from "./push-services";

// Push in this browser (push-device.ts) against a stand-in browser and server, so a test decides
// when each step finishes. The e2e test (e2e/notifications.spec.ts) runs it in Chromium.

const KEY = toBase64Url(Uint8Array.from({ length: 65 }, (_, n) => (n === 0 ? 4 : n)));

/** The server's copies of subscriptions, by endpoint. */
const { server } = vi.hoisted(() => ({ server: new Set<string>() }));

vi.mock("./push", () => ({
	getPushKey: async () => KEY,
	savePushSubscription: async ({ data }: { data: { endpoint: string } }) => {
		server.add(data.endpoint);
		return true;
	},
	removePushSubscription: async ({ data }: { data: { endpoint: string } }) => {
		server.delete(data.endpoint);
	},
}));

/**
 * A browser that allows notifications and holds one push subscription. Track waits for its
 * service worker until `release`, as it may while a page loads.
 */
function browser() {
	let subscription: PushSubscription | null = null;
	let made = 0;
	let release = () => {};
	let ready = Promise.resolve();
	const pushManager = {
		getSubscription: async () => subscription,
		subscribe: async (options: PushSubscriptionOptionsInit) => {
			made += 1;
			const endpoint = `https://fcm.googleapis.com/fcm/send/test-${made}`;
			const fresh: PushSubscription = {
				endpoint,
				options: { userVisibleOnly: true, applicationServerKey: options.applicationServerKey },
				toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }),
				unsubscribe: async () => {
					if (subscription === fresh) subscription = null;
					return true;
				},
			} as unknown as PushSubscription;
			subscription = fresh;
			return fresh;
		},
	};
	const registration = { pushManager };
	const storage = new Map<string, string>();
	vi.stubEnv("PROD", true);
	vi.stubGlobal("window", { PushManager: {}, Notification: {} });
	vi.stubGlobal("Notification", {
		permission: "granted",
		requestPermission: async () => "granted",
	});
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	vi.stubGlobal("navigator", {
		userAgent: "test",
		maxTouchPoints: 0,
		serviceWorker: {
			get ready() {
				return ready.then(() => registration);
			},
			getRegistration: async () => registration,
		},
	});
	return {
		subscription: () => subscription,
		/** Holds Track's wait for the service worker until `release` is called. */
		hold() {
			ready = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release: () => release(),
	};
}

beforeEach(() => {
	server.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("push in this browser", () => {
	it("turns on, and off", async () => {
		const here = browser();
		expect(await turnPushOn("u1", KEY)).toBe("on");
		expect(await pushIsOn("u1")).toBe(true);
		expect(await pushIsOn("u2")).toBe(false);
		expect(server.size).toBe(1);

		await turnPushOff();
		expect(await pushIsOn("u1")).toBe(false);
		expect(here.subscription()).toBeNull();
		expect(server.size).toBe(0);
	});

	// TRK-130: Track saves the subscription again as it starts. Turned off before that finished,
	// push came back on, in this browser and on the server.
	it("stays off when turned off while Track renews it", async () => {
		const here = browser();
		expect(await turnPushOn("u1", KEY)).toBe("on");

		here.hold();
		const renewing = keepPushOn("u1");
		const turningOff = turnPushOff();
		here.release();
		await Promise.all([renewing, turningOff]);

		expect(await pushIsOn("u1")).toBe(false);
		expect(here.subscription()).toBeNull();
		expect(server.size).toBe(0);

		// Nor does it come back the next time Track starts.
		await keepPushOn("u1");
		expect(await pushIsOn("u1")).toBe(false);
		expect(server.size).toBe(0);
	});
});
