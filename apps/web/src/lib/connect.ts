import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export type { Approval, ConnectOffer } from "#/server/connect";

// The page at /connect/agent (routes/connect.agent.tsx). The server modules are imported inside
// the handlers, so none of it reaches the browser.

const query = z.string().max(8192);

/** What the page shows: the request, checked, and the workspaces the person may add an agent to. */
export const getConnectOffer = createServerFn({ method: "GET" })
	.validator(query)
	.handler(async ({ data }) => {
		const { connectOffer } = await import("#/server/connect");
		return connectOffer(data, getRequest());
	});

/** The teams of a workspace the person is an owner or admin of, for the choice of one. */
export const getConnectTeams = createServerFn({ method: "GET" })
	.validator(z.string().min(1).max(64))
	.handler(async ({ data }) => {
		const { connectTeams } = await import("#/server/connect");
		return connectTeams(data, getRequest());
	});

/**
 * Allow or Cancel. Everything is checked again from the page's own query, and the answer is only
 * where to go next: the secrets are for the asking server, which fetches them with the code.
 */
export const approveAgentConnection = createServerFn({ method: "POST" })
	.validator(
		z.object({
			query,
			decision: z.enum(["allow", "cancel"]),
			workspace: z.string().min(1).max(64),
			teamId: z.string().min(1).max(64).nullable(),
			name: z.string().max(200),
		}),
	)
	.handler(async ({ data }) => {
		const { decideConnection } = await import("#/server/connect");
		return decideConnection(data, getRequest());
	});
