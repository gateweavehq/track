import {
	type SourceProduct,
	sourceSettingsSchema,
	WEBHOOK_EVENTS,
	type WebhookEventType,
} from "@gateweave/track-protocol";

/**
 * What another server asks of `/connect/agent` ("Connecting an agent in one step" in
 * docs/architecture.md), and whether it may ask it. The page and the server function that acts on
 * Allow both call this with the address's own query, so what the person saw is what is checked
 * again, and nothing the page sent back is trusted.
 */

export const CONNECT_PURPOSES = ["work", "triage"] as const;
export type ConnectPurpose = (typeof CONNECT_PURPOSES)[number];

/** As long as Better Auth's agent names may be (`agentName` in server/auth/agents.ts). */
export const MAX_AGENT_NAME_LENGTH = 80;

const MAX_URL_LENGTH = 2048;
const STATE = /^[A-Za-z0-9_-]{1,200}$/;
/** The unpadded base64url of a SHA-256 digest. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const KEYS = ["purpose", "name", "webhook", "events", "return", "state", "challenge"] as const;

export interface ConnectRequest {
	purpose: ConnectPurpose;
	/** The name suggested for the agent member, or a default for the purpose. */
	name: string;
	/** Where deliveries go. */
	webhook: string;
	events: WebhookEventType[];
	/** Where the person goes next, with the outcome added to its query. */
	returnTo: string;
	state: string;
	challenge: string;
	/** Who is asking: the origin of `webhook` and `returnTo`, which are the same. */
	origin: string;
}

export type ConnectCheck = { ok: true; request: ConnectRequest } | { ok: false; problem: string };

const refuse = (problem: string) => ({ ok: false as const, problem });

function repeated(params: URLSearchParams, keys: readonly string[]) {
	return keys.some((key) => params.getAll(key).length > 1);
}

function checkProof(params: URLSearchParams) {
	const state = params.get("state") ?? "";
	if (!STATE.test(state)) return refuse("The request's state is missing or malformed.");
	const challenge = params.get("challenge") ?? "";
	if (!CHALLENGE.test(challenge)) return refuse("The request's challenge is missing or malformed.");
	return { ok: true as const, state, challenge };
}

/** The default name for an agent made for a purpose. */
export function defaultAgentName(purpose: ConnectPurpose): string {
	return purpose === "triage" ? "Triage" : "Coder";
}

/**
 * Checks a request against Track's own address. Refuses, with a reason a person can read, whatever
 * could send the person's approval anywhere but the one origin they are shown.
 */
export function checkConnectRequest(query: string, trackOrigin: string): ConnectCheck {
	const params = new URLSearchParams(query);
	if (repeated(params, KEYS)) return refuse("The request names the same thing twice.");
	const get = (key: (typeof KEYS)[number]) => params.get(key) ?? "";

	const purpose = get("purpose");
	if (!isPurpose(purpose)) return refuse("The request does not say what the agent is for.");
	const proof = checkProof(params);
	if (!proof.ok) return proof;

	const name = get("name").trim();
	if (name.length > MAX_AGENT_NAME_LENGTH) {
		return refuse(`The suggested name is longer than ${MAX_AGENT_NAME_LENGTH} characters.`);
	}
	if (/\p{Cc}/u.test(name)) return refuse("The suggested name has control characters in it.");

	const events = parseEvents(get("events"));
	if (typeof events === "string") return refuse(events);

	const track = new URL(trackOrigin);
	const webhook = checkAddress(get("webhook"), "webhook", track);
	if (typeof webhook === "string") return refuse(webhook);
	const returnTo = checkAddress(get("return"), "return", track);
	if (typeof returnTo === "string") return refuse(returnTo);
	if (webhook.origin !== returnTo.origin) {
		return refuse("The webhook and the return address are not on the same origin.");
	}

	return {
		ok: true,
		request: {
			purpose,
			name: name || defaultAgentName(purpose),
			webhook: webhook.href,
			events,
			returnTo: returnTo.href,
			state: proof.state,
			challenge: proof.challenge,
			origin: webhook.origin,
		},
	};
}

const sourceFields = sourceSettingsSchema.pick({ product: true, name: true, linkOrigins: true });
const SOURCE_KEYS = ["product", "name", "links", "return", "state", "challenge"];

interface SourceConnectRequest {
	product: SourceProduct;
	name: string;
	linkOrigins: string[];
	otherLinkOrigins: string[];
	returnTo: string;
	origin: string;
	state: string;
	challenge: string;
}

/** The return address identifies the asker. Links on a source's issues can lead elsewhere. */
export function checkSourceConnectRequest(
	query: string,
	trackOrigin: string,
): { ok: true; request: SourceConnectRequest } | { ok: false; problem: string } {
	const params = new URLSearchParams(query);
	if (repeated(params, SOURCE_KEYS)) return refuse("The request names the same thing twice.");
	const proof = checkProof(params);
	if (!proof.ok) return proof;
	const returnTo = checkAddress(params.get("return") ?? "", "return", new URL(trackOrigin));
	if (typeof returnTo === "string") return refuse(returnTo);

	const links = params.get("links")?.split(",") ?? [returnTo.origin];
	if (links.length > 5) return refuse("The request names more than five link origins.");
	const product = params.get("product");
	const settings = sourceFields.safeParse({
		product,
		name: params.get("name")?.trim() || product,
		linkOrigins: links.map((link) => link.trim()),
	});
	if (!settings.success) {
		const field = settings.error.issues[0]?.path[0];
		if (field === "product") return refuse("The request names an unknown product.");
		if (field === "name")
			return refuse("The source name must fit on one line of 1 to 64 characters.");
		return refuse(
			"Each link must be an http or https origin without credentials, path, query or fragment.",
		);
	}
	const linkOrigins = [...new Set(settings.data.linkOrigins)];
	return {
		ok: true,
		request: {
			...settings.data,
			linkOrigins,
			otherLinkOrigins: linkOrigins.filter((link) => link !== returnTo.origin),
			returnTo: returnTo.href,
			origin: returnTo.origin,
			state: proof.state,
			challenge: proof.challenge,
		},
	};
}

/** What the page says when the call to approve got no answer: the server may have made both. */
export const UNKNOWN_RESULT_MESSAGE =
	"We couldn't tell whether this went through. Look in the workspace's settings under Agents and Webhooks before trying again.";

/**
 * What to tell the person when allowing did not end in an address to go to. An answer of `ok:
 * false` has been rolled back and says why, so its message is shown. No answer at all is unknown.
 */
export function approvalFailureMessage(answer: { ok: false; message: string } | null): string {
	return answer ? answer.message : UNKNOWN_RESULT_MESSAGE;
}

/** The address the person goes to next: `returnTo` with what happened added to its query. */
export function returnAddress(returnTo: string, outcome: Record<string, string>): string {
	const url = new URL(returnTo);
	// What the address already carries is kept, except what this sets: a second `code` or `state`
	// would leave the receiver to guess which was meant.
	for (const key of Object.keys(outcome)) url.searchParams.delete(key);
	for (const [key, value] of Object.entries(outcome)) url.searchParams.append(key, value);
	return url.href;
}

/**
 * The origins in `CONNECT_ORIGINS`, as origins. What is not an http(s) address is left out, as
 * a typo should not make an address known.
 */
export function parseConnectOrigins(value: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const entry of (value ?? "").split(",")) {
		if (!entry.trim()) continue;
		try {
			const url = new URL(entry.trim());
			if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
		} catch {
			// Not an address.
		}
	}
	return origins;
}

function isPurpose(value: string): value is ConnectPurpose {
	return (CONNECT_PURPOSES as readonly string[]).includes(value);
}

function parseEvents(value: string): WebhookEventType[] | string {
	const asked = value
		.split(",")
		.map((each) => each.trim())
		.filter(Boolean);
	if (asked.length === 0) return "The request names no events.";
	const unknown = asked.filter((each) => !(WEBHOOK_EVENTS as readonly string[]).includes(each));
	if (unknown.length > 0) return "The request names events that Track does not have.";
	// In Track's own order, as a webhook keeps them.
	return WEBHOOK_EVENTS.filter((event) => asked.includes(event));
}

/**
 * An address that deliveries or the person may go to: https, or http where Track itself is on
 * http (local development), the rule a webhook has; with no user name or password; and never
 * Track itself.
 */
function checkAddress(value: string, what: "webhook" | "return", track: URL): URL | string {
	const name = what === "webhook" ? "webhook" : "return address";
	if (!value || value.length > MAX_URL_LENGTH) return `The ${name} is missing or too long.`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return `The ${name} is not an address.`;
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && track.protocol === "http:")) {
		return `The ${name} must be an https address.`;
	}
	if (url.username || url.password) return `The ${name} has a user name or password in it.`;
	if (sameHost(url, track)) return `The ${name} is Track's own address.`;
	return url;
}

/** Whether two addresses name one host and port, as `track.example.com.` and `track.example.com` do. */
function sameHost(one: URL, other: URL): boolean {
	const host = (url: URL) => `${url.hostname.replace(/\.$/, "")}:${url.port}`;
	return host(one) === host(other);
}
