import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuth } = await import("#/server/auth");
	return getAuth().api.getSession({ headers: getRequestHeaders() });
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
	const session = await auth.api.getSession({ headers });
	if (!session || !demoEnabled()) return { session, sandbox: undefined };
	const [sandbox] = await auth.api.listOrganizations({ headers });
	return { session, sandbox: sandbox?.slug };
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { emailEnabled, githubEnabled } = await import("#/server/auth");
	const { demoEnabled } = await import("#/server/demo/mode");
	return { github: githubEnabled, email: emailEnabled, demo: demoEnabled() };
});
