import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "./auth";
import { schema } from "./db";
import { workspaceStub } from "./workspaces";

const UNSUBSCRIBE_ROUTE = /^\/api\/unsubscribe\/([^/]+)$/;
const ID = /^[\w-]{1,64}$/;

export function isUnsubscribeRequest(url: URL): boolean {
	return url.pathname.startsWith("/api/unsubscribe/");
}

/**
 * The link in an inbox email that turns its recipient's email off, in that workspace, without
 * signing in:
 *
 *   GET  /api/unsubscribe/:token  a page with a button, so that link scanners change nothing
 *   POST /api/unsubscribe/:token  turns email off; mail clients post here for one-click unsubscribe
 *                                 (RFC 8058), as the email's `List-Unsubscribe` header says
 *
 * The token names the workspace and the member and is signed with the app's secret, which stands
 * in for a session. The workspace must still exist in D1 before its Durable Object is reached.
 */
export async function handleUnsubscribeRequest(request: Request): Promise<Response> {
	const match = UNSUBSCRIBE_ROUTE.exec(new URL(request.url).pathname);
	const target = match?.[1] ? await readToken(decodeURIComponent(match[1])) : null;
	if (!target) return page(404, "This link does not work", "It may have been copied wrongly.");
	if (request.method === "GET" || request.method === "HEAD") {
		return page(
			200,
			"Stop inbox emails?",
			"You will no longer get emails about unread news in this workspace. Your inbox stays as it is, and you can turn email back on in your notification settings.",
			true,
		);
	}
	if (request.method !== "POST") return page(405, "Method not allowed", "");

	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, target.workspaceId))
		.get();
	if (workspace && (await workspaceStub(workspace.id).unsubscribe(target.memberId))) {
		return page(
			200,
			"Inbox emails are off",
			"You will no longer get emails about unread news in this workspace. You can turn them back on in your notification settings.",
		);
	}
	return page(404, "This link does not work", "You may no longer be a member of the workspace.");
}

/** The token for a member's link in a workspace. */
export async function unsubscribeToken(workspaceId: string, memberId: string): Promise<string> {
	const key = await signingKey();
	const mac = await crypto.subtle.sign("HMAC", key, signed(workspaceId, memberId));
	const signature = btoa(String.fromCharCode(...new Uint8Array(mac)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	return `${workspaceId}.${memberId}.${signature}`;
}

async function readToken(token: string) {
	const [workspaceId = "", memberId = "", signature = "", ...rest] = token.split(".");
	if (rest.length > 0 || !ID.test(workspaceId) || !ID.test(memberId)) return null;
	const mac = fromBase64Url(signature);
	if (!mac) return null;
	// `verify` compares in constant time.
	const valid = await crypto.subtle.verify(
		"HMAC",
		await signingKey(),
		mac,
		signed(workspaceId, memberId),
	);
	return valid ? { workspaceId, memberId } : null;
}

function signingKey() {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.BETTER_AUTH_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** What a token signs. Its purpose is part of it, so other uses of the secret make no tokens. */
function signed(workspaceId: string, memberId: string) {
	return new TextEncoder().encode(`track-unsubscribe:${workspaceId}:${memberId}`);
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[\w-]{43}$/.test(value)) return null;
	const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A small page of its own: the person may not be signed in, and the app is not needed. */
function page(status: number, heading: string, text: string, button = false): Response {
	const form = button
		? `<form method="post"><button type="submit" style="padding:10px 16px;background:#171717;color:#ffffff;border:0;border-radius:6px;font:inherit;font-weight:600;cursor:pointer">Stop emails</button></form>`
		: "";
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${heading} · Gateweave Track</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<main style="max-width:480px;margin:48px auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${heading}</h1>
<p style="margin:0 0 24px">${text}</p>
${form}
</main>
</body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}
