import { describe, expect, it } from "vitest";
import { fromBase64Url, isPushEndpoint, toBase64Url } from "#/lib/push-services";
import {
	encrypt,
	MAX_MESSAGE_BYTES,
	PushError,
	readVapidKey,
	sendWebPush,
	vapidAuthorization,
} from "./webpush";

/** The example in RFC 8291, section 5 and appendix A. */
const RFC = {
	message: "When I grow up, I want to be a watermelon",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	receiver:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	senderPublic:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A P-256 key pair from its private scalar and public point, for ECDH or ECDSA. */
async function keyPair(d: string, publicKey: string, algorithm: "ECDH" | "ECDSA") {
	const point = fromBase64Url(publicKey);
	const jwk = {
		kty: "EC",
		crv: "P-256",
		d,
		x: toBase64Url(point.slice(1, 33)),
		y: toBase64Url(point.slice(33, 65)),
	};
	const usages: KeyUsage[] = algorithm === "ECDH" ? ["deriveBits"] : ["sign"];
	const params = { name: algorithm, namedCurve: "P-256" };
	return {
		jwk,
		pair: {
			privateKey: await crypto.subtle.importKey("jwk", jwk, params, false, usages),
			publicKey: await crypto.subtle.importKey("raw", point, params, true, []),
		},
	};
}

const encoder = new TextEncoder();

describe("Web Push encryption", () => {
	it("matches RFC 8291's example", async () => {
		const { pair } = await keyPair(RFC.senderPrivate, RFC.senderPublic, "ECDH");
		const body = await encrypt(
			encoder.encode(RFC.message),
			{ p256dh: RFC.receiver, auth: RFC.auth },
			{ sender: pair, salt: fromBase64Url(RFC.salt) },
		);
		expect(toBase64Url(body)).toBe(RFC.body);
	});

	it("uses a new key and salt for every message", async () => {
		const target = { p256dh: RFC.receiver, auth: RFC.auth };
		const one = await encrypt(encoder.encode(RFC.message), target);
		const two = await encrypt(encoder.encode(RFC.message), target);
		expect(one.length).toBe(fromBase64Url(RFC.body).length);
		expect(toBase64Url(one.slice(0, 86))).not.toBe(toBase64Url(two.slice(0, 86)));
	});

	it("refuses keys of the wrong size, off the curve, or a message too long", async () => {
		const message = encoder.encode("hi");
		await expect(encrypt(message, { p256dh: RFC.auth, auth: RFC.auth })).rejects.toThrow(PushError);
		await expect(encrypt(message, { p256dh: RFC.receiver, auth: `${RFC.salt}AA` })).rejects.toThrow(
			PushError,
		);
		const offCurve = fromBase64Url(RFC.receiver);
		offCurve[64] = (offCurve[64] ?? 0) ^ 1;
		await expect(
			encrypt(message, { p256dh: toBase64Url(offCurve), auth: RFC.auth }),
		).rejects.toThrow(PushError);
		await expect(
			encrypt(new Uint8Array(MAX_MESSAGE_BYTES + 1), { p256dh: RFC.receiver, auth: RFC.auth }),
		).rejects.toThrow("too long");
	});
});

describe("VAPID", () => {
	const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc:def";

	it("signs a JWT for the push service's origin with the server's key", async () => {
		const { jwk } = await keyPair(RFC.senderPrivate, RFC.senderPublic, "ECDSA");
		const key = await readVapidKey(JSON.stringify(jwk));
		expect(key.publicKey).toBe(RFC.senderPublic);

		const now = Date.UTC(2026, 10, 12, 12);
		const header = await vapidAuthorization(ENDPOINT, key, "https://track.example.com", now);
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
		expect(match?.[4]).toBe(RFC.senderPublic);
		const [, head = "", claims = "", signature = ""] = match ?? [];
		const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
		expect(decode(head)).toEqual({ typ: "JWT", alg: "ES256" });
		expect(decode(claims)).toEqual({
			aud: "https://fcm.googleapis.com",
			exp: now / 1000 + 12 * 60 * 60,
			sub: "https://track.example.com",
		});
		const publicKey = await crypto.subtle.importKey(
			"raw",
			fromBase64Url(RFC.senderPublic),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			publicKey,
			fromBase64Url(signature),
			encoder.encode(`${head}.${claims}`),
		);
		expect(valid).toBe(true);
	});

	it("refuses a setting that is not a P-256 private key", async () => {
		await expect(readVapidKey("not json")).rejects.toThrow("not JSON");
		await expect(readVapidKey(JSON.stringify({ kty: "RSA" }))).rejects.toThrow("P-256");
		const { jwk } = await keyPair(RFC.senderPrivate, RFC.senderPublic, "ECDSA");
		await expect(readVapidKey(JSON.stringify({ ...jwk, d: "AAAA" }))).rejects.toThrow(PushError);
	});
});

describe("sending", () => {
	async function options(status: number) {
		const { jwk } = await keyPair(RFC.senderPrivate, RFC.senderPublic, "ECDSA");
		const requests: Request[] = [];
		const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return new Response(null, { status });
		}) as typeof fetch;
		return {
			requests,
			options: {
				key: await readVapidKey(JSON.stringify(jwk)),
				subject: "mailto:ops@example.com",
				topic: "issue-1",
				ttl: 3600,
				now: Date.now(),
				send,
			},
		};
	}
	const target = {
		endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
		p256dh: RFC.receiver,
		auth: RFC.auth,
	};

	it("posts the encrypted message with the headers push services want", async () => {
		const { requests, options: sendOptions } = await options(201);
		expect(await sendWebPush(target, '{"title":"Hi"}', sendOptions)).toBe("sent");
		const [request] = requests;
		expect(request?.url).toBe(target.endpoint);
		expect(request?.method).toBe("POST");
		expect(request?.headers.get("content-encoding")).toBe("aes128gcm");
		expect(request?.headers.get("ttl")).toBe("3600");
		expect(request?.headers.get("topic")).toBe("issue-1");
		expect(request?.headers.get("authorization")).toMatch(/^vapid t=.+, k=/);
		// The header, the message, its delimiter and the tag.
		expect((await request?.arrayBuffer())?.byteLength).toBe(86 + 14 + 1 + 16);
	});

	it("says a subscription is gone when the push service says so, and failed otherwise", async () => {
		expect(await sendWebPush(target, "{}", (await options(410)).options)).toBe("gone");
		expect(await sendWebPush(target, "{}", (await options(404)).options)).toBe("gone");
		expect(await sendWebPush(target, "{}", (await options(429)).options)).toBe("failed");
	});

	it("sends nothing to an address that is not a push service", async () => {
		const { requests, options: sendOptions } = await options(201);
		const elsewhere = { ...target, endpoint: "https://example.com/hook" };
		expect(await sendWebPush(elsewhere, "{}", sendOptions)).toBe("gone");
		expect(requests).toEqual([]);
	});
});

describe("push services", () => {
	it("are the browsers' own, over https", () => {
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/abc",
			"https://web.push.apple.com/QGv8",
			"https://wns2-par02p.notify.windows.com/w/?token=abc",
		]) {
			expect(isPushEndpoint(endpoint), endpoint).toBe(true);
		}
		for (const endpoint of [
			"http://fcm.googleapis.com/fcm/send/abc",
			"https://fcm.googleapis.com:8443/fcm/send/abc",
			"https://user:pass@fcm.googleapis.com/fcm/send/abc",
			"https://evil-fcm.googleapis.com.example.com/",
			"https://notfcm.googleapis.com.evil.test/",
			"https://example.com/",
			"not a url",
		]) {
			expect(isPushEndpoint(endpoint), endpoint).toBe(false);
		}
	});
});
