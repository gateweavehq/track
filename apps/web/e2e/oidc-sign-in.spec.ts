import type { BrowserContext, Page } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import { newPerson, signUp, unique, waitForHydration } from "./helpers";

// Signing in through an OpenID Connect provider, in a browser: the button, the trip to the provider
// (`e2e/provider.mjs`) and back, and what the page says when that fails. The Worker tests hold what
// the server accepts and refuses. What only a browser shows is that the page sends people off with
// a way back, and that the way back still works once it has been used.

const BUTTON = "Continue with Test Provider";

/** Who the provider will say this browser is. */
async function providerKnows(context: BrowserContext, person: object) {
	await context.addCookies([
		{
			name: "e2e-person",
			value: encodeURIComponent(JSON.stringify(person)),
			domain: "localhost",
			path: "/",
		},
	]);
}

function someone() {
	const id = unique("provider");
	return { sub: id, email: `${id}@example.test`, name: `Test ${id}`, email_verified: true };
}

async function pressButton(page: Page, path = "/login") {
	await page.goto(path);
	await waitForHydration(page);
	await page.getByRole("button", { name: BUTTON }).click();
}

test("someone new signs in through the provider, and stays signed in", async ({
	page,
	context,
}) => {
	await providerKnows(context, someone());

	await pressButton(page);

	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	await page.reload();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
});

test("someone who came through the provider has a name to change and no password", async ({
	page,
	context,
}) => {
	await providerKnows(context, someone());
	await pressButton(page);
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();

	await page.goto("/settings/account");
	await expect(page.getByLabel("Your name")).toBeVisible();
	await expect(page.getByText("this account has no password to change")).toBeVisible();
	await expect(page.getByRole("button", { name: "Change password" })).toHaveCount(0);
});

test("signing in through the provider ends up where they were going", async ({ page, context }) => {
	await providerKnows(context, someone());

	await pressButton(page, "/login?redirect=%2Finvite%2Fnone-such");

	await expect(page).toHaveURL(/\/invite\/none-such$/);
});

test("someone whose address has an account is told why, and can still use their password", async ({
	page,
	context,
	browser,
}) => {
	const person = newPerson("linked");
	const other = await newBrowserContext(browser);
	await signUp(await other.newPage(), person);
	await other.close();
	await providerKnows(context, { ...someone(), email: person.email });

	await pressButton(page, "/login?redirect=%2Finvite%2Fnone-such");

	await expect(page.getByRole("alert")).toContainText("already has an account");
	await expect(page).toHaveURL(/error=account_not_linked/);

	await waitForHydration(page);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/invite\/none-such$/);
});

test("someone who turns the provider down comes back to sign in another way", async ({
	page,
	context,
}) => {
	await providerKnows(context, { deny: true });

	await pressButton(page);

	await expect(page.getByRole("alert")).toContainText("You chose not to");
	await expect(page.getByRole("button", { name: BUTTON })).toBeEnabled();
});

test("a provider that cannot be reached leaves the button ready to try again", async ({ page }) => {
	// `test/oidc-sign-in.test.ts` shows the server answers this way when the provider is down.
	await page.route("**/api/auth/sign-in/social", (route) =>
		route.fulfill({
			status: 404,
			contentType: "application/json",
			body: JSON.stringify({ code: "PROVIDER_NOT_FOUND", message: "Provider not found" }),
		}),
	);

	await pressButton(page);

	await expect(page.getByRole("alert")).toContainText("could not reach Test Provider");
	await expect(page.getByRole("button", { name: BUTTON })).toBeEnabled();
});

test("an agent's authorization carries on after signing in through the provider", async ({
	page,
	context,
	baseURL,
	request,
}) => {
	await providerKnows(context, someone());
	const registered = await request.post("/api/auth/oauth2/register", {
		data: {
			client_name: "Browser test agent",
			redirect_uris: ["http://localhost:9/callback"],
			token_endpoint_auth_method: "none",
		},
	});
	expect(registered.ok()).toBe(true);
	const { client_id: clientId } = (await registered.json()) as { client_id: string };
	const authorize = new URLSearchParams({
		client_id: clientId,
		redirect_uri: "http://localhost:9/callback",
		response_type: "code",
		scope: "openid track",
		state: "1e5",
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
		resource: `${baseURL}/mcp`,
	});

	await page.goto(`/api/auth/oauth2/authorize?${authorize}`);
	await expect(page).toHaveURL(/\/login\?.*sig=/);
	await waitForHydration(page);
	await page.getByRole("button", { name: BUTTON }).click();

	await expect(page).toHaveURL(/\/oauth\/consent\?.*sig=/);
	// Allowing it sends the signed request back, so this also proves the page kept it intact: a state
	// that reads as a number, as this one does, must come back as the same text.
	await page.route("http://localhost:9/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Back at the agent</h1>" }),
	);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Allow" }).click();

	await expect(page.getByRole("heading", { name: "Back at the agent" })).toBeVisible();
	const back = new URL(page.url());
	expect(back.searchParams.get("state")).toBe("1e5");
	expect(back.searchParams.get("code")).toBeTruthy();
});
