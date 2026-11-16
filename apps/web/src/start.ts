import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { referenceIn } from "./lib/error-reference";

/**
 * Turns away a server function's request that another site's page sent: one whose `Sec-Fetch-Site`
 * is not `same-origin`, or without that header whose `Origin` (or else `Referer`) is not this
 * app's, or that carries none of the three. It is answered 403 before any handler runs, so
 * someone's cookie cannot be used from elsewhere.
 *
 * The framework adds this guard by itself only to an app without a start instance. Exporting one,
 * as this file does for `keepReference`, replaces its request middleware with what is listed
 * here, so the guard is listed, exactly as the framework's default. Track's gateways are server
 * routes, not server functions, and it leaves them alone.
 */
const refuseOtherSites = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Keeps a failure's reference with it on the way out of a server function. Only an error's
 * message crosses to the browser, and the reference of a failed database query may be further in:
 * Better Auth throws its own `Failed to get session` with the database's error as the cause. The
 * page would show the reference where it is rendered on the server and lose it in the browser.
 * So such an error leaves with the reference in its message, and nothing else of its cause.
 * Everything else, a redirect or a "not found" among it, is thrown as it was.
 */
const keepReference = createMiddleware({ type: "function" }).server(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		const reference = referenceIn(error);
		if (!reference || !(error instanceof Error) || referenceIn(new Error(error.message))) {
			throw error;
		}
		throw new Error(`${error.message} (reference ${reference})`);
	}
});

export const startInstance = createStart(() => ({
	requestMiddleware: [refuseOtherSites],
	functionMiddleware: [keepReference],
}));
