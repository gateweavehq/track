import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const { auth } = await import("#/server/auth");
	return auth.api.getSession({ headers: getRequestHeaders() });
});

export const getAuthOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { githubEnabled } = await import("#/server/auth");
	return { github: githubEnabled };
});
