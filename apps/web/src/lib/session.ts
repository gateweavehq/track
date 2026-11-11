import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * A session as it may reach a page. What a route's `beforeLoad` returns is written into the HTML,
 * where the cookie's point is that scripts and saved documents do not get the token, and no page
 * needs it.
 */
function withoutToken<Found extends { session: { token: string } }>(found: Found | null) {
	if (!found) return null;
	const { token: _token, ...session } = found.session;
	return { ...found, session };
}

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	return withoutToken(await getAuth().api.getSession({ headers: getRequestHeaders() }));
});

/**
 * What `/` needs: the session and, on the public demo, the visitor's sandbox. A returning
 * visitor goes straight back to it rather than to a list under a random-looking account.
 */
export const getHome = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	const headers = getRequestHeaders();
	const auth = getAuth();
	const session = withoutToken(await auth.api.getSession({ headers }));
	const legal = legalLinks();
	if (!session || !demoEnabled()) return { session, sandbox: undefined, legal };
	const [sandbox] = await auth.api.listOrganizations({ headers });
	return { session, sandbox: sandbox?.slug, legal };
});

/** What `/settings/account` needs: whose account it is, and whether deleting it asks for a password. */
export const getAccount = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	const auth = getAuth();
	const legal = legalLinks();
	const demo = demoEnabled();
	const found = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!found) return { account: null, demo, legal, ownsServer: false };
	const { internalAdapter } = await auth.$context;
	const accounts = await internalAdapter.findAccounts(found.user.id);
	const hasPassword = accounts.some(
		({ providerId, password }) => providerId === "credential" && Boolean(password),
	);
	const { name, email } = found.user;
	// Only to the one who runs the server, and never on the demo, where visitors are not owners of anything.
	const { db } = await import("#/server/auth");
	const { ownsDeployment } = await import("#/server/auth/deployment");
	const ownsServer = !demo && (await ownsDeployment(db, found.user.id));
	return { account: { name, email, hasPassword }, demo, legal, ownsServer };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { db, emailEnabled, githubEnabled, oidcProviderName } = await import("#/server/auth");
	const { signUpState } = await import("#/server/auth/deployment");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	const { signUpRequestUrl } = await import("#/server/sign-up-request");
	const demo = demoEnabled();
	// An empty server takes its first account, so it is not closed to whoever arrives first.
	const closed = !demo && (await signUpState(db)) === "by-invitation";
	return {
		github: githubEnabled,
		oidc: oidcProviderName,
		email: emailEnabled,
		demo,
		legal: legalLinks(),
		/** Whether the owner has closed sign-up, which the page says plainly. */
		signUpClosed: closed,
		/** Where to ask for access, shown only while sign-up is closed. */
		askForAccess: closed ? signUpRequestUrl() : null,
	};
});

export const getLegalLinks = createServerFn({ method: "GET" }).handler(async () => {
	const { legalLinks } = await import("#/server/legal");
	return legalLinks();
});
