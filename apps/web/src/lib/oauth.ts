import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

export interface ConsentRequest {
	/** The app asking for access, as it named itself when it registered. */
	clientName: string;
	viewer: { email: string } | null;
}

/** What the consent page shows. Null when the client does not exist or was disabled. */
export const getConsentRequest = createServerFn({ method: "GET" })
	.validator(z.string().min(1).max(256))
	.handler(async ({ data: clientId }): Promise<ConsentRequest | null> => {
		const { getAuth } = await import("#/server/auth");
		const auth = getAuth();
		const headers = getRequestHeaders();
		const session = await auth.api.getSession({ headers });
		if (!session) return { clientName: "", viewer: null };
		try {
			const client = await auth.api.getOAuthClientPublic({
				query: { client_id: clientId },
				headers,
			});
			return {
				clientName: client.client_name?.trim() || "An unnamed app",
				viewer: { email: session.user.email },
			};
		} catch {
			return null;
		}
	});

/** Where a grant goes, in terms a person can check. Shared by the consent page and the account page. */
export function destination(redirectUri: string | null | undefined): string {
	if (!redirectUri) return "the app";
	try {
		const url = new URL(redirectUri);
		if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
			return "an app on this computer";
		}
		return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol;
	} catch {
		return "the app";
	}
}

export interface AssistantGrant {
	clientId: string;
	/** What the app called itself, or null if it gave no name. */
	name: string | null;
	goesTo: string;
	allowedAt: number;
	lastUsedAt: number | null;
}

/** The signed-in person's grants to AI assistants, most recently used first. */
export const getAssistantGrants = createServerFn({ method: "GET" }).handler(
	async (): Promise<AssistantGrant[]> => {
		const { db, getAuth } = await import("#/server/auth");
		const { listGrants } = await import("#/server/auth/grants");
		const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
		if (!session) return [];
		const grants = await listGrants(db, session.user.id);
		return grants.map(({ clientId, name, redirectUri, allowedAt, lastUsedAt }) => ({
			clientId,
			name,
			goesTo: destination(redirectUri),
			allowedAt,
			lastUsedAt,
		}));
	},
);

/** Ends the signed-in person's grant to one app at once. Not found for anyone else's or an unknown one. */
export const takeBackAssistant = createServerFn({ method: "POST" })
	.validator(z.string().min(1).max(256))
	.handler(async ({ data: clientId }): Promise<{ ok: boolean }> => {
		const { db, getAuth } = await import("#/server/auth");
		const { takeBack } = await import("#/server/auth/grants");
		const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
		if (!session) return { ok: false };
		return { ok: await takeBack(db, session.user.id, clientId) };
	});
