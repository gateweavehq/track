/** A new value for every response, so a script tag injected into a page cannot guess it. */
export function newNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes));
}

/** Where GitHub keeps the pictures it gives at sign-in. */
const GITHUB_PICTURES = "https://avatars.githubusercontent.com";

/** What an import from GitHub or Linear reads, from the browser. See `lib/import`. */
const IMPORT_SOURCES = "https://api.github.com https://api.linear.app";

/** Whether a host can go in a policy as it is. A URL may hold a semicolon, which ends a directive. */
function isPlainHost(host: string): boolean {
	return /^[\w.:[\]-]+$/.test(host);
}

/** The origin of a configured address, or nothing for one that is not a web address. */
function webOrigin(address: string | undefined): string | undefined {
	if (!address) return undefined;
	try {
		const url = new URL(address);
		const isWeb = url.protocol === "https:" || url.protocol === "http:";
		return isWeb && isPlainHost(url.host) ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

export interface PagePolicyOptions {
	/** The address of the page, whose host its sync socket opens on. */
	url: URL;
	/** The OpenID Connect provider this deployment signs in through, if any. */
	oidcIssuer?: string | undefined;
}

/**
 * What a page of Track may load. A workspace's pages hold everything its members wrote, and act for
 * them over a socket, so a script that got in would be the worst thing that could happen here, and
 * nothing but Track may frame them.
 *
 * Styles stay at `'unsafe-inline'`: Radix sets `style` attributes and Sonner adds a style tag, and a
 * style cannot run code the way a script can.
 *
 * Images are the one thing a page shows from elsewhere: a member's picture, from where their sign-in
 * got it. Allowing every host would let a script that got in carry a workspace out in an image's
 * address, so a picture from any other host shows the member's initials instead.
 */
export function contentSecurityPolicy(nonce: string, { url, oidcIssuer }: PagePolicyOptions) {
	const pictures = [GITHUB_PICTURES, webOrigin(oidcIssuer)].filter(Boolean).join(" ");
	// `'self'` covers the socket in the specification, but browsers came to that at different times.
	const scheme = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = isPlainHost(url.host) ? ` ${scheme}//${url.host}` : "";
	return [
		"default-src 'none'",
		`script-src 'self' 'nonce-${nonce}'`,
		"style-src 'self' 'unsafe-inline'",
		// `blob:` is an attachment's preview while it waits to upload.
		`img-src 'self' data: blob: ${pictures}`,
		"font-src 'self'",
		`connect-src 'self'${socket} ${IMPORT_SOURCES}`,
		"worker-src 'self'",
		"manifest-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	].join("; ");
}

/**
 * Adds the headers every response gets, and the ones a page gets, to what the app answered. A page
 * that sets its own policy keeps it: the request form loads Turnstile, and an attached file may load
 * nothing at all. So does one with a stricter rule for referrers, which has a token in its address.
 */
export function withSecurityHeaders(
	request: Request,
	response: Response,
	{ nonce, oidcIssuer }: { nonce: string; oidcIssuer?: string | undefined },
): Response {
	// A socket's upgrade. It has no headers a browser reads, and a copy would lose the socket.
	if (response.status === 101) return response;

	const secured = new Response(response.body, response);
	const { headers } = secured;
	const url = new URL(request.url);
	headers.set("X-Content-Type-Options", "nosniff");
	// An invitation's id and a reset's token are in their pages' addresses. This keeps paths and
	// queries from other sites.
	if (!headers.has("Referrer-Policy")) {
		headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	}
	if (url.protocol === "https:") {
		// Not `includeSubDomains`: on a self-hosted deployment those hosts are someone else's.
		headers.set("Strict-Transport-Security", "max-age=31536000");
	}
	if (
		headers.get("Content-Type")?.startsWith("text/html") &&
		!headers.has("Content-Security-Policy")
	) {
		headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, { url, oidcIssuer }));
		// For browsers that predate `frame-ancestors`.
		headers.set("X-Frame-Options", "DENY");
		// The page carries this response's nonce, and what it shows depends on who is signed in.
		headers.set("Cache-Control", "private, no-store");
	}
	return secured;
}
