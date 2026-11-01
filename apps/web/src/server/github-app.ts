import { env } from "cloudflare:workers";
import { isAdminRole } from "@gateweave/track-protocol";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, getAuth } from "./auth";
import { readText } from "./body";
import { schema } from "./db";
import { answer, MAX_GITHUB_BODY } from "./github";
import { webhooksEnabled } from "./webhooks";
import { findMembershipById, workspaceStub } from "./workspaces";

/**
 * The deployment's GitHub App (TRK-58): admins install it on their repositories instead of adding
 * a webhook by hand.
 *
 *   GET  /api/github/app/setup     where GitHub sends the admin back after installing it
 *   GET  /api/github/app/callback  where GitHub sends them back after authorizing the app
 *   POST /api/github/app           where every installation's deliveries come
 *
 * An installation id in a request is anyone's to make up, so one is connected to a workspace only
 * once GitHub vouches for it: back from installing the app, the admin is sent on to authorize it,
 * and the user token the code from that buys must list the installation, on an account the person
 * controls: an organization they are an admin of, or their own. Each step carries a state of its own, signed, naming the workspace and the admin. Deliveries
 * carry no workspace; D1 says which one has the installation, and the workspace's Durable Object
 * checks the signature with the app's secret, and that the delivery is about that installation.
 */

export const GITHUB_APP_SETUP_PATH = "/api/github/app/setup";
export const GITHUB_APP_CALLBACK_PATH = "/api/github/app/callback";
const GITHUB_APP_DELIVERY_PATH = "/api/github/app";

/** How long an admin has to install the app once they set out from settings. */
const STATE_MS = 60 * 60 * 1000;

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";

/** The app's settings, or null where the deployment has no app, or takes no deliveries. */
export function githubApp() {
	const {
		GITHUB_APP_SLUG: slug,
		GITHUB_APP_CLIENT_ID: clientId,
		GITHUB_APP_CLIENT_SECRET: clientSecret,
		GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
	} = env;
	if (!slug || !clientId || !clientSecret || !webhookSecret || !webhooksEnabled()) return null;
	return { slug, clientId, clientSecret };
}

export function isGitHubAppRequest(url: URL): boolean {
	return [GITHUB_APP_DELIVERY_PATH, GITHUB_APP_SETUP_PATH, GITHUB_APP_CALLBACK_PATH].includes(
		url.pathname,
	);
}

/**
 * Where an admin installs the app for a workspace. The state names the workspace and the admin,
 * signed and short-lived, so the way back connects nothing for anyone else.
 */
export async function githubAppInstallUrl(
	workspaceId: string,
	userId: string,
	now = Date.now(),
): Promise<string | null> {
	const app = githubApp();
	if (!app) return null;
	const state = await signState({
		step: "install",
		workspaceId,
		userId,
		expires: now + STATE_MS,
		installationId: null,
	});
	return `${GITHUB}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export async function handleGitHubAppRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const app = githubApp();
	if (!app) return answer(404, "Not found");
	if (url.pathname === GITHUB_APP_SETUP_PATH || url.pathname === GITHUB_APP_CALLBACK_PATH) {
		if (request.method !== "GET") return answer(405, "Method not allowed", { Allow: "GET" });
		return url.pathname === GITHUB_APP_SETUP_PATH
			? setup(request, url, app)
			: callback(request, url, app);
	}
	if (request.method !== "POST") return answer(405, "Method not allowed", { Allow: "POST" });
	return deliver(request);
}

/**
 * Back from installing the app: sends the admin on to authorize it, which tells whose
 * installation it is. Nothing is connected yet.
 */
async function setup(
	request: Request,
	url: URL,
	app: NonNullable<ReturnType<typeof githubApp>>,
): Promise<Response> {
	const installationId = url.searchParams.get("installation_id") ?? "";
	// An installation that waits for an organization owner to approve it has no id yet.
	if (url.searchParams.get("setup_action") === "request" && !installationId) {
		return page(
			202,
			"Waiting for approval",
			"An owner of the GitHub organization has to approve the app. Once they have, start again from your workspace's GitHub settings.",
		);
	}
	const checked = await checkState(request, url, "install");
	if (checked instanceof Response) return checked;
	if (!/^\d{1,20}$/.test(installationId)) return badLink();
	const state = await signState({ ...checked.state, step: "authorize", installationId });
	const authorize = new URL(`${GITHUB}/login/oauth/authorize`);
	authorize.searchParams.set("client_id", app.clientId);
	authorize.searchParams.set("redirect_uri", new URL(GITHUB_APP_CALLBACK_PATH, url).toString());
	authorize.searchParams.set("state", state);
	return new Response(null, { status: 302, headers: { Location: authorize.toString() } });
}

/** Connects the installation the admin is back with, once GitHub says they can reach it. */
async function callback(
	request: Request,
	url: URL,
	app: NonNullable<ReturnType<typeof githubApp>>,
): Promise<Response> {
	const checked = await checkState(request, url, "authorize");
	if (checked instanceof Response) return checked;
	const { state, membership } = checked;
	const installationId = state.installationId ?? "";
	const code = url.searchParams.get("code");
	if (!code) {
		return page(
			400,
			"GitHub was not authorized",
			"Track needs to know who you are on GitHub to connect the app. Start again from your workspace's GitHub settings.",
		);
	}

	const controlled = await controlledInstallation(app, code, installationId);
	if (controlled === undefined) {
		return page(502, "GitHub could not be reached", "Try again in a moment.");
	}
	if (controlled === "unreachable") {
		return page(
			403,
			"That installation is not yours",
			"GitHub does not list it among the installations you can reach.",
		);
	}
	if (controlled === "not_admin") {
		return page(
			403,
			"Only the account's admins connect it",
			"Connecting an installation of the app takes an owner of the GitHub organization it is installed on, or the GitHub user it is installed for.",
		);
	}

	const stub = workspaceStub(state.workspaceId);
	const connected = await stub.connectGitHubApp(membership.profile, {
		id: installationId,
		account: controlled.account,
	});
	if (!connected.ok) return page(400, "GitHub was not connected", connected.message);
	// The claim is the one check of who has the installation: insert, or take over the row only
	// where this workspace already has it, in one statement, so two workspaces connecting at
	// once cannot both pass a check and leave a row that is half one's and half the other's.
	const claimed = await db
		.insert(schema.githubInstallation)
		.values({
			installationId,
			organizationId: state.workspaceId,
			connectionId: connected.value.id,
			createdAt: Date.now(),
		})
		.onConflictDoUpdate({
			target: schema.githubInstallation.installationId,
			set: { connectionId: connected.value.id },
			setWhere: eq(schema.githubInstallation.organizationId, state.workspaceId),
		})
		.returning({ installationId: schema.githubInstallation.installationId })
		.get();
	if (!claimed) {
		// Another workspace has it: the connection just made would never get a delivery.
		const undone = await stub.deleteGitHubConnection(membership.profile, connected.value.id);
		if (!undone.ok) {
			console.error("A GitHub App connection that lost its claim was not removed", {
				reason: undone.reason,
			});
		}
		return page(
			409,
			"Another workspace has this installation",
			"An installation of the app belongs to one workspace. Disconnect it there first, or install the app again on other repositories.",
		);
	}

	const workspace = await db
		.select({ slug: schema.organization.slug })
		.from(schema.organization)
		.where(eq(schema.organization.id, state.workspaceId))
		.get();
	const back = workspace ? `/${encodeURIComponent(workspace.slug)}/settings/github` : "/";
	return new Response(null, { status: 302, headers: { Location: back } });
}

const tokenResponse = z.object({ access_token: z.string().min(1) });
const installationAccount = z.object({
	login: z.string().min(1),
	id: z.number().int(),
	type: z.string(),
});
const installationsResponse = z.object({
	installations: z.array(
		z.object({
			id: z.number().int(),
			// Kept loose here: an installation the person cannot control may have any account.
			account: z.unknown(),
		}),
	),
});
const userResponse = z.object({ id: z.number().int() });
const membershipResponse = z.object({
	state: z.string(),
	role: z.string(),
	organization: z.object({ id: z.number().int() }),
});

/**
 * The installation as the person controls it on GitHub, asked with their user token, bought with
 * the code. Being able to reach it is not enough: GitHub lists an organization's installation for
 * anyone who can read one of its repositories, so the person must be an active admin of the
 * organization it is installed on, or be the user it is installed for. "unreachable" when the
 * token does not list it (or GitHub does not take the code), "not_admin" when the person does not
 * control its account, undefined when GitHub could not be asked.
 */
async function controlledInstallation(
	app: NonNullable<ReturnType<typeof githubApp>>,
	code: string,
	installationId: string,
): Promise<{ account: string } | "unreachable" | "not_admin" | undefined> {
	try {
		const exchanged = await fetch(`${GITHUB}/login/oauth/access_token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
		});
		const token = tokenResponse.safeParse(exchanged.ok ? await exchanged.json() : null);
		// A code that GitHub does not take is one nobody can vouch for.
		if (!token.success) return "unreachable";
		const headers = {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token.data.access_token}`,
			"User-Agent": "Gateweave Track",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		let listed: unknown;
		for (let page = 1; page <= 10 && listed === undefined; page += 1) {
			const response = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
				headers,
			});
			if (!response.ok) return undefined;
			const parsed = installationsResponse.safeParse(await response.json());
			if (!parsed.success) return undefined;
			const found = parsed.data.installations.find(({ id }) => String(id) === installationId);
			if (found) listed = found.account ?? null;
			else if (parsed.data.installations.length < 100) return "unreachable";
		}
		if (listed === undefined) return "unreachable";
		// An installation on an enterprise, or with no account, is not one Track connects.
		const account = installationAccount.safeParse(listed);
		if (!account.success) return "not_admin";
		const { login, id, type } = account.data;

		if (type === "User") {
			const response = await fetch(`${GITHUB_API}/user`, { headers });
			if (!response.ok) return undefined;
			const user = userResponse.safeParse(await response.json());
			if (!user.success) return undefined;
			return user.data.id === id ? { account: login } : "not_admin";
		}
		if (type !== "Organization") return "not_admin";
		// Needs the app's "Members: read" organization permission. GitHub answers 404 to someone
		// who is not a member.
		const response = await fetch(
			`${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(login)}`,
			{ headers },
		);
		if (response.status === 404) return "not_admin";
		if (!response.ok) {
			console.error("GitHub would not say whether a person is an organization's admin", {
				status: response.status,
			});
			return undefined;
		}
		const membership = membershipResponse.safeParse(await response.json());
		if (!membership.success) return undefined;
		const { state, role, organization } = membership.data;
		return state === "active" && role === "admin" && organization.id === id
			? { account: login }
			: "not_admin";
	} catch (error) {
		console.error("GitHub could not be asked about an installation", {
			error: error instanceof Error ? error.name : typeof error,
		});
		return undefined;
	}
}

const aboutInstallation = z.object({
	action: z.string().optional(),
	installation: z.object({ id: z.number().int() }),
});

/**
 * A delivery of the app's, for whichever workspace has its installation. What the body says of
 * its installation only routes it: the workspace's Durable Object checks the signature.
 */
async function deliver(request: Request): Promise<Response> {
	const event = request.headers.get("X-GitHub-Event");
	const deliveryId = request.headers.get("X-GitHub-Delivery");
	if (!event || !deliveryId) return answer(400, "Not a GitHub delivery");
	if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
		return answer(415, "Set the app's webhook content type to application/json");
	}
	const body = await readText(request, MAX_GITHUB_BODY);
	if (body === null) return answer(413, "Delivery too large");
	let about: z.infer<typeof aboutInstallation> | null = null;
	try {
		const parsed = aboutInstallation.safeParse(JSON.parse(body));
		about = parsed.success ? parsed.data : null;
	} catch {
		about = null;
	}
	// The app's own ping names no installation.
	if (!about) return answer(202, "Accepted");
	const installationId = String(about.installation.id);
	const found = await db
		.select()
		.from(schema.githubInstallation)
		.where(eq(schema.githubInstallation.installationId, installationId))
		.get();
	// An installation no workspace has connected yet, such as one being set up.
	if (!found) return answer(202, "No workspace has connected this installation");

	const { status } = await workspaceStub(found.organizationId).github({
		connectionId: found.connectionId,
		deliveryId,
		event,
		signature: request.headers.get("X-Hub-Signature-256"),
		body,
	});
	// The workspace dropped the connection, or the app was uninstalled: forget the installation.
	const uninstalled = status === 202 && event === "installation" && about.action === "deleted";
	if (status === 404 || uninstalled) {
		await forgetGitHubInstallation(found.organizationId, found.connectionId);
	}
	switch (status) {
		case 202:
			return answer(202, "Accepted");
		case 400:
			return answer(400, "Not a GitHub delivery");
		case 401:
			return answer(401, "The signature does not match the app's secret");
		case 404:
			return answer(202, "No workspace has connected this installation");
	}
}

/**
 * Forgets which installation a workspace's connection has, once the connection is gone, so that
 * another workspace can connect the installation at once. Only that workspace's row for that
 * connection goes: by then another may have claimed the installation.
 */
export async function forgetGitHubInstallation(
	workspaceId: string,
	connectionId: string,
): Promise<void> {
	await db
		.delete(schema.githubInstallation)
		.where(
			and(
				eq(schema.githubInstallation.organizationId, workspaceId),
				eq(schema.githubInstallation.connectionId, connectionId),
			),
		)
		.run();
}

// The state that goes to GitHub and back: workspace, admin and expiry, signed with the app's
// own secret, for this purpose alone.

interface State {
	/** Setting out to install the app, or back from that, setting out to authorize it. */
	step: "install" | "authorize";
	workspaceId: string;
	userId: string;
	expires: number;
	/** The installation to authorize; null when setting out to install. */
	installationId: string | null;
}

const ID = /^[\w-]{1,64}$/;

function statePayload(state: State): string {
	return [
		state.step,
		state.workspaceId,
		state.userId,
		state.expires,
		state.installationId ?? "-",
	].join(".");
}

async function signState(state: State): Promise<string> {
	const payload = statePayload(state);
	const mac = await crypto.subtle.sign("HMAC", await signingKey(), signed(payload));
	return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

async function readState(token: string): Promise<State | null> {
	const [
		step = "",
		workspaceId = "",
		userId = "",
		expires = "",
		installation = "",
		signature = "",
		...rest
	] = token.split(".");
	if (
		rest.length > 0 ||
		(step !== "install" && step !== "authorize") ||
		!ID.test(workspaceId) ||
		!ID.test(userId) ||
		!/^\d{1,16}$/.test(expires) ||
		!(step === "install" ? installation === "-" : /^\d{1,20}$/.test(installation))
	) {
		return null;
	}
	const state: State = {
		step,
		workspaceId,
		userId,
		expires: Number(expires),
		installationId: installation === "-" ? null : installation,
	};
	const mac = fromBase64Url(signature);
	if (!mac) return null;
	// `verify` compares in constant time.
	const valid = await crypto.subtle.verify(
		"HMAC",
		await signingKey(),
		mac,
		signed(statePayload(state)),
	);
	return valid ? state : null;
}

function signingKey() {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** What a state signs. Its purpose is part of it, so other uses of the secret make no states. */
function signed(payload: string) {
	return new TextEncoder().encode(`track-github-app:${payload}`);
}

function toBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[\w-]{43}$/.test(value)) return null;
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The state the way back carries, for this step, from the admin who set out, still an admin of
 * the workspace; or the page that says why not.
 */
async function checkState(request: Request, url: URL, step: State["step"]) {
	const state = await readState(url.searchParams.get("state") ?? "");
	if (!state || state.step !== step) return badLink();
	if (state.expires < Date.now()) {
		return page(400, "This link has expired", "Start again from your workspace's GitHub settings.");
	}
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session || session.user.id !== state.userId) {
		return page(
			403,
			"Sign in first",
			"Sign in as the person who started connecting GitHub, then start again.",
		);
	}
	const membership = await findMembershipById(db, state.workspaceId, state.userId);
	if (!membership || !isAdminRole(membership.profile.role)) {
		return page(
			403,
			"Only admins connect GitHub",
			"Ask an owner or admin of the workspace to connect it.",
		);
	}
	return { state, membership };
}

function badLink() {
	return page(400, "This link does not work", "Start again from your workspace's GitHub settings.");
}

/** A small page of its own for the way back from GitHub, when something stops it. */
function page(status: number, heading: string, text: string): Response {
	const escaped = (value: string) =>
		value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${escaped(heading)} · Gateweave Track</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<main style="max-width:480px;margin:48px auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escaped(heading)}</h1>
<p style="margin:0">${escaped(text)}</p>
</main>
</body>
</html>`;
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}
