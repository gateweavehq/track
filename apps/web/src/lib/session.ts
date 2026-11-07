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

/** What `/account` needs: whose account it is, and whether deleting it asks for a password. */
export const getAccount = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	const auth = getAuth();
	const legal = legalLinks();
	const demo = demoEnabled();
	const found = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!found) return { account: null, demo, legal };
	const { internalAdapter } = await auth.$context;
	const accounts = await internalAdapter.findAccounts(found.user.id);
	const hasPassword = accounts.some(
		({ providerId, password }) => providerId === "credential" && Boolean(password),
	);
	const { name, email } = found.user;
	return { account: { name, email, hasPassword }, demo, legal };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled, oidcProviderName } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	const { legalLinks } = await import("#/server/legal");
	return {
		github: githubEnabled,
		oidc: oidcProviderName,
		email: emailEnabled,
		demo: demoEnabled(),
		legal: legalLinks(),
	};
});

export const getLegalLinks = createServerFn({ method: "GET" }).handler(async () => {
	const { legalLinks } = await import("#/server/legal");
	return legalLinks();
});
