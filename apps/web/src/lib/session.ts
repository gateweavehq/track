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
	const headers = getRequestHeaders();
	const auth = getAuth();
	const session = withoutToken(await auth.api.getSession({ headers }));
	if (!session || !demoEnabled()) return { session, sandbox: undefined };
	const [sandbox] = await auth.api.listOrganizations({ headers });
	return { session, sandbox: sandbox?.slug };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled, oidcProviderName } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	return {
		github: githubEnabled,
		oidc: oidcProviderName,
		email: emailEnabled,
		demo: demoEnabled(),
	};
});
