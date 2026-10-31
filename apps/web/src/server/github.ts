import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { webhooksEnabled } from "./webhooks";
import { workspaceStub } from "./workspaces";

const GITHUB_ROUTE = /^\/api\/github\/([^/]+)\/([^/]+)$/;

/**
 * The largest delivery read. GitHub caps payloads at 25 MB, but what Track reads, a pull request
 * or a push of at most 20 commits, is far smaller; the rest is mostly repository details.
 */
export const MAX_GITHUB_BODY = 1024 * 1024;

export function isGitHubRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/github/");
}

/**
 * Where GitHub sends a workspace's webhook deliveries:
 *
 *   POST /api/github/:workspaceId/:connectionId
 *
 * There is no session to check. The workspace's Durable Object checks the delivery's signature
 * against the connection's secret, which never leaves it. The workspace must exist in D1 first,
 * so made-up ids never reach, or create, a Durable Object.
 */
export async function handleGitHubRequest(request: Request): Promise<Response> {
	const match = GITHUB_ROUTE.exec(new URL(request.url).pathname);
	// The public demo connects to nothing outside, as it sends no webhooks.
	if (!match || !webhooksEnabled()) return answer(404, "Not found");
	if (request.method !== "POST") return answer(405, "Method not allowed", { Allow: "POST" });
	const [, workspaceId = "", connectionId = ""] = match;

	const event = request.headers.get("X-GitHub-Event");
	const deliveryId = request.headers.get("X-GitHub-Delivery");
	if (!event || !deliveryId) return answer(400, "Not a GitHub delivery");
	// The signature covers the raw body in either format, but only JSON is parsed.
	if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
		return answer(415, "Set the webhook's content type to application/json");
	}

	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, decodeURIComponent(workspaceId)))
		.get();
	if (!workspace) return answer(404, "Not found");

	const body = await readText(request, MAX_GITHUB_BODY);
	if (body === null) return answer(413, "Delivery too large");

	const { status } = await workspaceStub(workspace.id).github({
		connectionId: decodeURIComponent(connectionId),
		deliveryId,
		event,
		signature: request.headers.get("X-Hub-Signature-256"),
		body,
	});
	// GitHub shows the response with each delivery, so it says what went wrong.
	switch (status) {
		case 202:
			return answer(202, "Accepted");
		case 400:
			return answer(400, "Not a GitHub delivery");
		case 401:
			return answer(401, "The signature does not match the connection's secret");
		case 404:
			return answer(404, "Not found");
	}
}

/** The body as text, or null when it is longer than `max` bytes. Stops reading there. */
async function readText(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get("Content-Length"));
	if (declared > max) return null;
	if (!request.body) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function answer(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json(status < 400 ? { message } : { error: message }, { status, headers });
}
