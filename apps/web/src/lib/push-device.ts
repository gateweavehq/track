import { getPushKey, removePushSubscription, savePushSubscription } from "./push";
import { fromBase64Url, toBase64Url } from "./push-services";

// Push in this browser. The browser's subscription is the device; the server keeps a copy tied
// to the session it was saved in, which it sends to.

/** The user who turned push on in this browser, so that whoever signs in next doesn't inherit it. */
const MARK = "track:push";

/**
 * Whether this browser can take push. On iPhone and iPad, Safari can only once Track is added to
 * the Home Screen. The service worker, which shows notifications, exists in production builds.
 */
export function pushSupport(): "ready" | "home-screen" | "none" {
	if (typeof window === "undefined") return "none";
	if (
		import.meta.env.PROD &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	) {
		return "ready";
	}
	const apple =
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
	return apple && !window.matchMedia("(display-mode: standalone)").matches ? "home-screen" : "none";
}

function markedFor(): string | null {
	try {
		return localStorage.getItem(MARK);
	} catch {
		return null;
	}
}

function mark(userId: string | null): void {
	try {
		if (userId) localStorage.setItem(MARK, userId);
		else localStorage.removeItem(MARK);
	} catch {
		// Without storage, push stays on until it is turned off; it is only not renewed.
	}
}

async function currentSubscription(): Promise<PushSubscription | null> {
	const registration = await navigator.serviceWorker.getRegistration();
	return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Whether push is on in this browser for this person. */
export async function pushIsOn(userId: string): Promise<boolean> {
	if (pushSupport() !== "ready" || Notification.permission !== "granted") return false;
	return markedFor() === userId && (await currentSubscription()) !== null;
}

/** Subscribes with the server's key, and saves the subscription on the server for this session. */
async function subscribe(userId: string, key: string): Promise<boolean> {
	const registration = await navigator.serviceWorker.ready;
	let subscription = await registration.pushManager.getSubscription();
	const subscribedWith = subscription?.options.applicationServerKey;
	// A subscription made with another key, before the server's changed, can't be pushed to.
	if (subscription && (!subscribedWith || toBase64Url(new Uint8Array(subscribedWith)) !== key)) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: fromBase64Url(key),
	});
	const { keys } = subscription.toJSON();
	const saved = await savePushSubscription({
		data: {
			endpoint: subscription.endpoint,
			keys: { p256dh: keys?.p256dh ?? "", auth: keys?.auth ?? "" },
		},
	});
	if (saved) mark(userId);
	return saved;
}

/** Held while push changes in this browser, in any tab. */
const LOCK = "track:push-change";

/** Changes in this tab, one after another, where the browser has no Web Locks. */
let changes: Promise<unknown> = Promise.resolve();

/**
 * Runs `change` once no other change to push is running here. Each one awaits the browser and the
 * server several times, and another that ran in between was undone: push turned off while Track
 * renewed it came back on (TRK-130).
 */
function changingPush<T>(change: () => Promise<T>): Promise<T> {
	if (typeof navigator !== "undefined" && navigator.locks) {
		return navigator.locks.request(LOCK, change);
	}
	const run = changes.then(change);
	changes = run.catch(() => {});
	return run;
}

/** Asks the browser's permission, then turns push on. */
export async function turnPushOn(
	userId: string,
	key: string,
): Promise<"on" | "denied" | "refused"> {
	const permission = await Notification.requestPermission();
	if (permission !== "granted") return "denied";
	return changingPush(async () => ((await subscribe(userId, key)) ? "on" : "refused"));
}

export function turnPushOff(): Promise<void> {
	return changingPush(async () => {
		mark(null);
		const subscription = await currentSubscription();
		if (!subscription) return;
		await removePushSubscription({ data: { endpoint: subscription.endpoint } }).catch(() => {});
		await subscription.unsubscribe();
	});
}

/**
 * Saves the subscription again whenever Track starts for the person who turned push on here. That
 * ties it to the current session, so push carries on after a session runs out and another begins.
 */
export async function keepPushOn(userId: string): Promise<void> {
	if (pushSupport() !== "ready" || Notification.permission !== "granted") return;
	await changingPush(async () => {
		// Read on its turn: push may have been turned off while it waited.
		if (markedFor() !== userId) return;
		const key = await getPushKey();
		if (key) await subscribe(userId, key);
	});
}

/**
 * On signing out. The server's copy goes with the session; this ends the browser's subscription
 * too, as a browser may be shared.
 */
export function forgetPushHere(): Promise<void> {
	return changingPush(async () => {
		mark(null);
		if (pushSupport() !== "ready") return;
		await (await currentSubscription())?.unsubscribe();
	});
}
