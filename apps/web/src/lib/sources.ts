import { sourceAction } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";

const workspace = z.string().min(1);

export const getSourceSettings = createServerFn({ method: "GET" })
	.validator(workspace)
	.handler(async ({ data }) => {
		const { readSources } = await import("#/server/sources");
		return readSources(data, getRequest());
	});

export const changeSource = createServerFn({ method: "POST" })
	.validator(z.object({ workspace, action: sourceAction }))
	.handler(async ({ data }) => {
		const { editSource } = await import("#/server/sources");
		setResponseHeader("Cache-Control", "no-store");
		const result = await editSource(data.workspace, getRequest(), data.action);
		if (!result.ok && "retryAfter" in result && result.retryAfter !== undefined) {
			setResponseStatus(429);
			setResponseHeader("Retry-After", String(result.retryAfter));
		}
		return result;
	});
