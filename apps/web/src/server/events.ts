import { EVENT_MAX_BYTES } from "@gateweave/track-protocol";
import { appOrigin, db } from "./auth";
import { countedByWhoSentIt } from "./auth/workers-address";
import { readText } from "./body";
import { demoEnabled } from "./demo/mode";
import { limitBadSourceKeys } from "./rate-limit";
import { findSourceByKey } from "./source-keys";
import { workspaceStub } from "./workspaces";

function missing(retryAfter?: number) {
	return Response.json(
		{ error: "not_found" },
		{
			status: 404,
			headers: retryAfter ? { "retry-after": String(retryAfter) } : undefined,
		},
	);
}

async function refuseKey(request: Request) {
	const counted = await countedByWhoSentIt(new Request(request.url, { headers: request.headers }));
	const limit = await limitBadSourceKeys(counted.headers.get("cf-connecting-ip") ?? "unknown");
	return missing(limit.allowed ? undefined : (limit.retryAfter ?? undefined));
}

export async function handleEvent(request: Request): Promise<Response> {
	if (demoEnabled()) return missing();
	if (request.method !== "POST") {
		return Response.json(
			{ error: "method_not_allowed" },
			{ status: 405, headers: { allow: "POST" } },
		);
	}
	const key = /^Bearer (gws_[A-Za-z0-9_-]{43})$/i.exec(
		request.headers.get("authorization") ?? "",
	)?.[1];
	const found = await findSourceByKey(db, key ?? null);
	if (!found) return refuseKey(request);

	const base = new URL(`/${encodeURIComponent(found.slug)}`, appOrigin(request));
	const raw = await readText(request, EVENT_MAX_BYTES, true);
	const result = await workspaceStub(found).sourceEvent(found.sourceId, raw, base.href);
	switch (result.status) {
		case 404:
			return refuseKey(request);
		case 400:
			return Response.json({ error: "invalid_event" }, { status: 400 });
		case 429:
			return Response.json(
				{ error: "too_many_requests" },
				{
					status: 429,
					headers: { "retry-after": String(result.retryAfter) },
				},
			);
		case 200:
			return Response.json(result.answer);
	}
}
