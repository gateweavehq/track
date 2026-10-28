import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthTokens,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// An AI agent connecting to Track from scratch, against the built Worker in workerd: discovery,
// dynamic client registration, sign-in, consent, the PKCE code exchange and tool calls. Unit
// tests stub each piece; this is what caught nothing when MCP failed in production (TRK-1).

const origin = "https://track.test";
// Never called: the test reads the code from where consent sends the browser.
const redirectUrl = "http://127.0.0.1:47199/callback";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

/** Calls Better Auth as a browser on Track's own pages would. */
async function authApi(path: string, cookie: string | null, body: object) {
	const response = await track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

async function signUp(email: string) {
	const response = await authApi("/sign-up/email", null, {
		name: "Maya Chen",
		email,
		password: "a-long-test-password",
	});
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

/** An MCP client's OAuth state, kept in memory. */
class MemoryProvider implements OAuthClientProvider {
	client: OAuthClientInformationMixed | undefined;
	savedTokens: OAuthTokens | undefined;
	verifier = "";
	authorizationUrl: URL | undefined;

	get redirectUrl() {
		return redirectUrl;
	}
	get clientMetadata() {
		return {
			client_name: "Track integration test",
			redirect_uris: [redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	clientInformation() {
		return this.client;
	}
	saveClientInformation(client: OAuthClientInformationMixed) {
		this.client = client;
	}
	tokens() {
		return this.savedTokens;
	}
	saveTokens(tokens: OAuthTokens) {
		this.savedTokens = tokens;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}
}

describe("MCP over OAuth, in the Workers runtime", () => {
	it("connects an agent from scratch and lets it work as the person who approved it", async () => {
		const cookie = await signUp("maya@example.com");
		await authApi("/organization/create", cookie, { name: "Acme", slug: "acme" });

		const provider = new MemoryProvider();
		const transport = () =>
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				authProvider: provider,
				fetch: track.fetch,
			});

		// Without a token, the agent is sent to authorize, after registering itself.
		const client = new Client({ name: "track-test", version: "1.0.0" });
		await expect(client.connect(transport())).rejects.toBeInstanceOf(UnauthorizedError);
		expect(provider.client?.client_id).toBeTruthy();
		const authorize = provider.authorizationUrl;
		if (!authorize) throw new Error("The agent was never sent to authorize");
		expect(authorize.searchParams.get("resource")).toBe(`${origin}/mcp`);

		// Signed in, the person lands on the consent page and allows the agent. Requests from this
		// test arrive as fetches (undici sets Sec-Fetch-Mode), so Better Auth answers with where to
		// go next, as it does for its own client, instead of redirecting.
		const toConsent = await track.fetch(authorize, { headers: { cookie } });
		const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
		expect(consent.pathname).toBe("/oauth/consent");
		const decision = await authApi("/oauth2/consent", cookie, {
			accept: true,
			oauth_query: consent.search.slice(1),
		});
		const callback = new URL(((await decision.json()) as { url: string }).url);
		expect(`${callback.origin}${callback.pathname}`).toBe(redirectUrl);

		// The agent redeems the code with its PKCE verifier and calls tools with the token.
		await transport().finishAuth(callback.searchParams);
		expect(provider.savedTokens?.scope).toContain("track");
		await client.connect(transport());

		const workspaces = await client.callTool({ name: "list_workspaces", arguments: {} });
		const workspace = await client.callTool({
			name: "get_workspace",
			arguments: { workspace: "acme" },
		});
		const other = await client.callTool({
			name: "get_workspace",
			arguments: { workspace: "someone-elses" },
		});
		await client.close();

		expect(workspaces.structuredContent).toEqual({
			workspaces: [{ slug: "acme", name: "Acme", role: "owner" }],
		});
		// Read from the workspace's Durable Object, which the gateway reached over RPC.
		expect(workspace.structuredContent).toMatchObject({
			teams: [],
			members: [{ name: "Maya Chen", email: "maya@example.com", role: "owner" }],
		});
		expect(other.isError).toBe(true);
		expect(track.outbound).toEqual([]);
	});

	it("answers a bad token with a challenge, not an error", async () => {
		const response = await track.fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				authorization: "Bearer not.a.token",
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
		expect(track.outbound).toEqual([]);
	});
});
