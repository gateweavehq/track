/**
 * The push services of the browsers that have one: Chrome's and most others' (Google), Firefox's
 * (Mozilla), Safari's (Apple) and Edge's (Microsoft). The server only sends to these, so a
 * subscription can't make it post to any other address.
 */
const PUSH_SERVICES = [
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"push.apple.com",
	"notify.windows.com",
];

/** Whether a subscription's endpoint is an https address at a known push service. */
export function isPushEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
		return false;
	}
	const host = url.hostname;
	return PUSH_SERVICES.some((service) => host === service || host.endsWith(`.${service}`));
}

/** Bytes from base64url, with or without padding. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
