import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { db } from "./auth";
import { readText } from "./body";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { limitRequests } from "./rate-limit";
import { workspaceStub } from "./workspaces";

const FORM_ROUTE = /^\/request\/([\w-]{1,64})\/([0-9a-f]{32})$/;

/** A form's fields are short; this leaves room for a long description and nothing more. */
const MAX_FORM_BODY = 128 * 1024;

const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** What a person types into the form. */
const submission = z.object({
	title: z.string().trim().min(1, "Give the request a title.").max(512, "Shorten the title."),
	description: z.string().max(20_000, "Shorten the description."),
	email: z.union([z.literal(""), z.email("Check the email address.").max(254)]),
});

export function isIntakeFormRequest(url: URL): boolean {
	return url.pathname.startsWith("/request/");
}

/** Whether forms take requests here: Turnstile is set up, and this is not the public demo. */
export function intakeFormsEnabled(): boolean {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) && !demoEnabled();
}

/**
 * A team's public request form, which anyone with its link can fill in:
 *
 *   GET  /request/:workspaceId/:formKey  the form
 *   POST /request/:workspaceId/:formKey  files the request into the team's intake
 *
 * There is no session. The form's key, which an admin can replace, admits the person, Turnstile
 * keeps bots out, and each client network can file only so many requests. The workspace must
 * exist in D1 before its Durable Object is reached, so made-up ids never create one.
 */
export async function handleIntakeFormRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = FORM_ROUTE.exec(url.pathname);
	const siteKey = env.TURNSTILE_SITE_KEY;
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!match || !siteKey || !secret || demoEnabled()) return notFound();
	const [, workspaceId = "", formKey = ""] = match;

	const workspace = await db
		.select({ id: schema.organization.id, name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, workspaceId))
		.get();
	const stub = workspace && workspaceStub(workspace.id);
	const form = stub && (await stub.intakeForm(formKey));
	if (!workspace || !stub || !form) return notFound();
	const where = { workspace: workspace.name, team: form.teamName, siteKey };

	if (request.method === "GET" || request.method === "HEAD") return formPage(200, where);
	if (request.method !== "POST") return message(405, "Method not allowed", "");

	const body = await readText(request, MAX_FORM_BODY);
	if (body === null) return formPage(413, where, {}, "The request is too long.");
	const fields = new URLSearchParams(body);
	const values = {
		title: fields.get("title") ?? "",
		description: fields.get("description") ?? "",
		email: (fields.get("email") ?? "").trim(),
	};
	const parsed = submission.safeParse(values);
	if (!parsed.success) {
		return formPage(400, where, values, parsed.error.issues[0]?.message ?? "Check the form.");
	}

	// Cloudflare sets this to the address it saw; clients cannot choose it.
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (!(await limitRequests(address)).allowed) {
		return formPage(429, where, values, "You have sent a lot of requests. Try again later.");
	}
	const token = fields.get("cf-turnstile-response") ?? "";
	if (!(await verifyTurnstile(secret, token, address))) {
		return formPage(403, where, values, "We could not tell you are a person. Try again.");
	}

	const { title, description, email } = parsed.data;
	const filed = await stub.fileRequest({
		formKey,
		title,
		description: describe(description, email),
		sortOrder: generateKeyBetween(await stub.lastSortOrder(), null),
	});
	if (!filed) return notFound();
	return message(
		201,
		"Request sent",
		`Thanks. Your request is with ${escapeHtml(form.teamName)} at ${escapeHtml(workspace.name)}, who will look at it.`,
	);
}

/** The request's description, which says who sent it when they left an address. */
export function describe(description: string, email: string): string | null {
	const text = description.trim();
	if (!email) return text || null;
	const from = `Sent through the request form by <${email}>.`;
	return text ? `${text}\n\n${from}` : from;
}

/**
 * Asks Turnstile whether a token is a passed challenge. Each token works once. Anything but a
 * clear yes, including Turnstile being unreachable, is a no.
 */
export async function verifyTurnstile(
	secret: string,
	token: string,
	address: string,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	if (!token || token.length > 2048) return false;
	try {
		const response = await fetcher(TURNSTILE_VERIFY, {
			method: "POST",
			body: new URLSearchParams({ secret, response: token, remoteip: address }),
		});
		if (!response.ok) return false;
		const outcome = (await response.json()) as { success?: unknown };
		return outcome.success === true;
	} catch (error) {
		console.error("intake form: Turnstile could not be reached", error);
		return false;
	}
}

interface FormValues {
	title?: string;
	description?: string;
	email?: string;
}

function formPage(
	status: number,
	where: { workspace: string; team: string; siteKey: string },
	values: FormValues = {},
	problem?: string,
): Response {
	const field =
		"display:block;width:100%;box-sizing:border-box;margin:6px 0 16px;padding:8px 10px;border:1px solid #d4d4d4;border-radius:6px;font:inherit;color:inherit;background:#ffffff";
	const label = "display:block;font-weight:600;font-size:14px";
	const alert = problem
		? `<p role="alert" style="margin:0 0 16px;padding:8px 12px;border-radius:6px;background:#fef2f2;color:#b91c1c">${escapeHtml(problem)}</p>`
		: "";
	const content = `
<p style="margin:0 0 24px;color:#525252">Your request goes to ${escapeHtml(where.team)} at ${escapeHtml(where.workspace)}, who decide whether to take it on.</p>
${alert}
<form method="post">
<label style="${label}" for="title">Title</label>
<input style="${field}" id="title" name="title" required maxlength="512" value="${escapeHtml(values.title ?? "")}">
<label style="${label}" for="description">Description <span style="font-weight:400;color:#737373">(optional)</span></label>
<textarea style="${field};min-height:140px;resize:vertical" id="description" name="description" maxlength="20000">${escapeHtml(values.description ?? "")}</textarea>
<label style="${label}" for="email">Your email <span style="font-weight:400;color:#737373">(optional, for questions about it)</span></label>
<input style="${field}" id="email" name="email" type="email" maxlength="254" autocomplete="email" value="${escapeHtml(values.email ?? "")}">
<div class="cf-turnstile" data-sitekey="${escapeHtml(where.siteKey)}" style="margin:0 0 16px"></div>
<button type="submit" style="padding:10px 16px;background:#171717;color:#ffffff;border:0;border-radius:6px;font:inherit;font-weight:600;cursor:pointer">Send request</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
	return html(status, `Request for ${where.team}`, content);
}

function message(status: number, heading: string, text: string): Response {
	return html(status, heading, `<p style="margin:0">${text}</p>`);
}

function notFound(): Response {
	return message(404, "This form is not open", "The link may be old, or the team turned it off.");
}

/** A page of its own: whoever fills in the form is not signed in, and the app is not needed. */
function html(status: number, heading: string, content: string): Response {
	const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${escapeHtml(heading)} · Gateweave Track</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<main style="max-width:560px;margin:48px auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${content}
</main>
</body>
</html>`;
	return new Response(page, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			// Turnstile's script and frame are all the page loads from elsewhere.
			"Content-Security-Policy":
				"default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
