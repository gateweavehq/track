import { fromBase64Url, isPushEndpoint, toBase64Url } from "#/lib/push-services";

/**
 * Web Push with WebCrypto alone: the message is encrypted for the browser (RFC 8291, with RFC
 * 8188's aes128gcm), so the push service carries it without reading it, and the server signs
 * who it is to the push service (VAPID, RFC 8292).
 */

/** One browser's subscription, as `PushSubscription.toJSON()` gives it. */
export interface PushTarget {
	endpoint: string;
	/** The browser's P-256 public key, uncompressed, in base64url. */
	p256dh: string;
	/** Its 16-byte authentication secret, in base64url. */
	auth: string;
}

/** The server's key, which signs for every push it sends. */
export interface VapidKey {
	privateKey: CryptoKey;
	/** The public key, uncompressed, which browsers subscribe with. */
	publicKey: string;
}

/** A message the server can't send, such as one for a subscription with keys of the wrong size. */
export class PushError extends Error {
	override name = "PushError";
}

/** The whole body, header included, must fit in 4096 bytes. */
const RECORD_SIZE = 4096;
const HEADER_SIZE = 86;
/** The tag AES-GCM adds, and the padding delimiter. */
export const MAX_MESSAGE_BYTES = RECORD_SIZE - HEADER_SIZE - 16 - 1;

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

async function hkdf(
	salt: Uint8Array<ArrayBuffer>,
	ikm: Uint8Array<ArrayBuffer>,
	info: Uint8Array<ArrayBuffer>,
	bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		key,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

/**
 * Encrypts a message for one browser, as one record. The sender's key pair and the salt are new
 * for every message; tests pass RFC 8291's to check the result against its example.
 */
export async function encrypt(
	message: Uint8Array,
	target: Pick<PushTarget, "p256dh" | "auth">,
	fixed: { sender?: CryptoKeyPair; salt?: Uint8Array<ArrayBuffer> } = {},
): Promise<Uint8Array<ArrayBuffer>> {
	if (message.length > MAX_MESSAGE_BYTES) throw new PushError("The message is too long to push");
	const receiver = fromBase64Url(target.p256dh);
	const authSecret = fromBase64Url(target.auth);
	if (receiver.length !== 65 || receiver[0] !== 4 || authSecret.length !== 16) {
		throw new PushError("The subscription's keys are not a P-256 key and a 16-byte secret");
	}
	// Importing checks that the point is on the curve, which RFC 8291 requires.
	const receiverKey = await crypto.subtle
		.importKey("raw", receiver, { name: "ECDH", namedCurve: "P-256" }, false, [])
		.catch(() => {
			throw new PushError("The subscription's key is not on the P-256 curve");
		});
	const sender =
		fixed.sender ??
		((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveBits",
		])) as CryptoKeyPair);
	const senderPublic = new Uint8Array(
		(await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer,
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256),
	);
	const ikm = await hkdf(
		authSecret,
		shared,
		concat(encoder.encode("WebPush: info\0"), receiver, senderPublic),
		32,
	);
	const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// One record, so the last: its padding delimiter is 2, with no padding after it.
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce },
		key,
		concat(message, Uint8Array.of(2)),
	);
	const header = new Uint8Array(HEADER_SIZE);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = senderPublic.length;
	header.set(senderPublic, 21);
	return concat(header, new Uint8Array(ciphertext));
}

/**
 * Reads the server's key: a P-256 private key as a JWK, with its public point (`x` and `y`), as
 * `scripts/push-key.mjs` makes it. Throws a {@link PushError} for anything else.
 */
export async function readVapidKey(setting: string): Promise<VapidKey> {
	let jwk: Record<string, unknown>;
	try {
		jwk = JSON.parse(setting);
	} catch {
		throw new PushError("PUSH_VAPID_KEY is not JSON");
	}
	const { kty, crv, d, x, y } = jwk;
	if (
		kty !== "EC" ||
		crv !== "P-256" ||
		typeof d !== "string" ||
		typeof x !== "string" ||
		typeof y !== "string"
	) {
		throw new PushError("PUSH_VAPID_KEY is not a P-256 private key as a JWK");
	}
	const privateKey = await crypto.subtle
		.importKey("jwk", { kty, crv, d, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
		])
		.catch(() => {
			throw new PushError("PUSH_VAPID_KEY is not a usable P-256 key");
		});
	return {
		privateKey,
		publicKey: toBase64Url(concat(Uint8Array.of(4), fromBase64Url(x), fromBase64Url(y))),
	};
}

/**
 * The `Authorization` header that tells the push service who sends (RFC 8292): a JWT for the
 * endpoint's origin, signed with the server's key, and that key. `subject` is how to reach whoever
 * runs the server, a `mailto:` or `https:` URL.
 */
export async function vapidAuthorization(
	endpoint: string,
	key: VapidKey,
	subject: string,
	now: number,
): Promise<string> {
	const encode = (value: object) => toBase64Url(encoder.encode(JSON.stringify(value)));
	const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
		aud: new URL(endpoint).origin,
		// Push services accept up to a day.
		exp: Math.floor(now / 1000) + 12 * 60 * 60,
		sub: subject,
	})}`;
	// WebCrypto signs as r and s side by side, which is what ES256 wants.
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key.privateKey,
		encoder.encode(unsigned),
	);
	return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${key.publicKey}`;
}

/** What became of a push: sent, refused for good because the subscription is gone, or failed. */
export type PushOutcome = "sent" | "gone" | "failed";

export interface PushOptions {
	key: VapidKey;
	subject: string;
	/**
	 * Replaces an earlier message with the same topic that the push service still holds, as for a
	 * device that is off. At most 32 base64url characters.
	 */
	topic?: string;
	/** How long the push service keeps the message for a device that is off, in seconds. */
	ttl: number;
	now: number;
	send?: typeof fetch;
}

/** Encrypts and sends one message to one browser. */
export async function sendWebPush(
	target: PushTarget,
	message: string,
	{ key, subject, topic, ttl, now, send = fetch }: PushOptions,
): Promise<PushOutcome> {
	if (!isPushEndpoint(target.endpoint)) return "gone";
	const body = await encrypt(encoder.encode(message), target);
	const response = await send(target.endpoint, {
		method: "POST",
		headers: {
			authorization: await vapidAuthorization(target.endpoint, key, subject, now),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(ttl),
			urgency: "normal",
			...(topic && { topic }),
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	await response.body?.cancel();
	// RFC 8030: the subscription expired or was removed. Anything else may work next time.
	if (response.status === 404 || response.status === 410) return "gone";
	return response.ok ? "sent" : "failed";
}
