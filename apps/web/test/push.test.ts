import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../src/lib/push-services";
import { startTrack } from "./track-worker";

// Push notifications (TRK-126) in the built Worker. The workspace's Durable Object decides what is
// news and when (sync-server's tests cover that) and hands it to the app's subclass, which these
// tests call as the alarm does. A stand-in push service at Google's address takes the messages,
// which the tests decrypt with the browser's key, as the browser would.

const origin = "https://track.test";
const client = "203.0.113.91";
const PUSH_HOST = "fcm.googleapis.com";

interface Pushed {
	path: string;
	headers: Record<string, string>;
	body: Uint8Array<ArrayBuffer>;
}

const pushed: Pushed[] = [];
let track: Awaited<ReturnType<typeof startTrack>>;
let vapidPublicKey: string;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	vapidPublicKey = toBase64Url(
		new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
	);
	track = await startTrack(origin, {
		vars: { PUSH_VAPID_KEY: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) },
		outbound: async (request, url) => {
			if (url.host !== PUSH_HOST) return undefined;
			pushed.push({
				path: url.pathname,
				headers: Object.fromEntries(request.headers),
				body: new Uint8Array(await request.arrayBuffer()),
			});
			// A browser that unsubscribed: the push service says it is gone for good.
			return new Response(null, { status: url.pathname.endsWith("/gone") ? 410 : 201 });
		},
	});
	const signUp = await authApi("/sign-up/email", {
		name: "Pia",
		email: "pia@track.test",
		password: "a-long-test-password",
	});
	userId = ((await signUp.json()) as { user: { id: string } }).user.id;
	const cookie = signUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await authApi("/organization/create", { name: "Push", slug: "push" }, cookie);
	workspaceId = ((await created.json()) as { id: string }).id;
});

afterAll(async () => {
	await track?.dispose();
});

beforeEach(async () => {
	pushed.length = 0;
	await track.db.prepare("DELETE FROM push_subscription").run();
});

function authApi(path: string, body: object, cookie?: string) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

/** A browser's push subscription: its key pair and secret, which only it knows. */
async function browser() {
	const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	])) as CryptoKeyPair;
	const publicKey = new Uint8Array(
		(await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
	);
	return { keys, publicKey, auth: crypto.getRandomValues(new Uint8Array(16)) };
}

type Browser = Awaited<ReturnType<typeof browser>>;

/** Saves a subscription for the user's live session, as the app does when push is turned on. */
async function subscribe(device: Browser, path: string) {
	const session = await track.db
		.prepare("SELECT id FROM session WHERE user_id = ?")
		.bind(userId)
		.first<{ id: string }>();
	await track.db
		.prepare(
			"INSERT INTO push_subscription (endpoint, user_id, session_id, p256dh, auth, saved_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(
			`https://${PUSH_HOST}${path}`,
			userId,
			session?.id,
			toBase64Url(device.publicKey),
			toBase64Url(device.auth),
			Date.now(),
		)
		.run();
}

/** What the object hands its `sendPush` (sync-server's `PushNotice`). */
function notice(workspace = workspaceId) {
	return {
		workspace: { id: workspace, slug: "push", origin },
		member: { id: userId },
		items: [
			{
				issue: { key: "ENG-7", title: "Fix <login>" },
				event: { type: "comment", commentId: "comment-1" },
				actor: "Hal",
				unread: 1,
				updatedAt: Date.now(),
				comment: "Can you look at this today?",
				statusName: null,
			},
		],
	};
}

async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: string | Uint8Array<ArrayBuffer>,
	bytes: number,
) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
		key,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

/** Decrypts a message as the browser does (RFC 8291). */
async function decrypt(device: Browser, body: Uint8Array<ArrayBuffer>): Promise<unknown> {
	const salt = body.slice(0, 16);
	const keyLength = body[20] ?? 0;
	const senderPublic = body.slice(21, 21 + keyLength);
	const sender = await crypto.subtle.importKey(
		"raw",
		senderPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, device.keys.privateKey, 256),
	);
	const info = new Uint8Array([
		...new TextEncoder().encode("WebPush: info\0"),
		...device.publicKey,
		...senderPublic,
	]);
	const ikm = await hkdf(device.auth, shared, info, 32);
	const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
	const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + keyLength)),
	);
	expect(plain.at(-1)).toBe(2);
	return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

describe("push notifications", () => {
	it("reach each of a member's browsers, encrypted to it and signed by the server", async () => {
		const phone = await browser();
		const laptop = await browser();
		await subscribe(phone, "/fcm/send/phone");
		await subscribe(laptop, "/fcm/send/laptop");
		await track.rpc(workspaceId, "sendPush", notice());

		expect(pushed.map((each) => each.path).sort()).toEqual(["/fcm/send/laptop", "/fcm/send/phone"]);
		const toPhone = pushed.find((each) => each.path === "/fcm/send/phone");
		expect(await decrypt(phone, toPhone?.body ?? new Uint8Array())).toEqual({
			title: "ENG-7 Fix <login>",
			body: "Hal commented on ENG-7\nCan you look at this today?",
			url: "/push/issue/ENG-7",
			tag: `${workspaceId}/ENG-7`,
		});
		// Only the phone's key opens the phone's message.
		await expect(decrypt(laptop, toPhone?.body ?? new Uint8Array())).rejects.toThrow();

		const headers = toPhone?.headers ?? {};
		expect(headers["content-encoding"]).toBe("aes128gcm");
		expect(headers.ttl).toBe("86400");
		expect(headers.topic).toMatch(/^[\w-]{32}$/);
		const vapid = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
			headers.authorization ?? "",
		);
		expect(vapid?.[4]).toBe(vapidPublicKey);
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(vapid?.[2] ?? "")));
		expect(claims).toMatchObject({ aud: `https://${PUSH_HOST}`, sub: origin });
		const verifier = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(vapidPublicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const signed = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			verifier,
			fromBase64Url(vapid?.[3] ?? ""),
			new TextEncoder().encode(`${vapid?.[1]}.${vapid?.[2]}`),
		);
		expect(signed).toBe(true);
		expect(track.outbound).toEqual([]);
	});

	it("forgets a browser the push service no longer knows", async () => {
		await subscribe(await browser(), "/fcm/send/gone");
		await subscribe(await browser(), "/fcm/send/kept");
		await track.rpc(workspaceId, "sendPush", notice());
		expect(pushed).toHaveLength(2);
		const left = await track.db.prepare("SELECT endpoint FROM push_subscription").all();
		expect(left.results).toEqual([{ endpoint: `https://${PUSH_HOST}/fcm/send/kept` }]);
	});

	it("goes nowhere for a session that ran out, or a workspace the person is not in", async () => {
		await subscribe(await browser(), "/fcm/send/phone");
		await track.rpc(workspaceId, "sendPush", notice("some-other-workspace"));
		expect(pushed).toEqual([]);

		await track.db
			.prepare("UPDATE session SET expires_at = ? WHERE user_id = ?")
			.bind(Date.now() - 1000, userId)
			.run();
		try {
			await track.rpc(workspaceId, "sendPush", notice());
			expect(pushed).toEqual([]);
		} finally {
			await track.db
				.prepare("UPDATE session SET expires_at = ? WHERE user_id = ?")
				.bind(Date.now() + 7 * 24 * 60 * 60 * 1000, userId)
				.run();
		}
	});

	it("goes with the session it was turned on in", async () => {
		await subscribe(await browser(), "/fcm/send/phone");
		await track.db.prepare("DELETE FROM session WHERE user_id = ?").bind(userId).run();
		const left = await track.db.prepare("SELECT count(*) AS n FROM push_subscription").first();
		expect(left).toEqual({ n: 0 });
	});
});
