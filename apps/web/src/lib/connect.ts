import { SOURCE_THRESHOLDS } from "@gateweave/track-protocol";
import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export type { Approval, ConnectOffer } from "#/server/connect";

// The page at /connect/agent (routes/connect.agent.tsx). The server modules are imported inside
// the handlers, so none of it reaches the browser.

export const rawConnectQuery = createIsomorphicFn()
	.server(() => new URL(getRequest().url).search)
	.client(() => window.location.search);

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

export const getSourceConnectOffer = createServerFn({ method: "GET" })
	.validator(query)
	.handler(async ({ data }) => {
		const { sourceConnectOffer } = await import("#/server/connect");
		return sourceConnectOffer(data, getRequest());
	});

export const getSourceConnectChoices = createServerFn({ method: "GET" })
	.validator(z.string().min(1).max(64))
	.handler(async ({ data }) => {
		const { sourceConnectChoices } = await import("#/server/connect");
		return sourceConnectChoices(data, getRequest());
	});

export const approveSourceConnection = createServerFn({ method: "POST" })
	.validator(
		z.object({
			query,
			decision: z.enum(["allow", "cancel"]),
			workspace: z.string().min(1).max(64),
			teamId: z.string().max(64),
			lowestSeverity: z.enum(SOURCE_THRESHOLDS),
			closeWhenCleared: z.boolean(),
			assigneeId: z.string().min(1).max(64).nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const { decideSourceConnection } = await import("#/server/connect");
		return decideSourceConnection(data, getRequest());
	});
