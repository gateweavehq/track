import { env } from "cloudflare:workers";

/**
 * True only on the public demo deployment (the `demo` environment in wrangler.jsonc). The same
 * code ships everywhere, so every demo entry point checks this first.
 */
export function demoEnabled(): boolean {
	return env.TRACK_DEMO === "1";
}

/** Stops a demo-only action on any other deployment. */
export function assertDemo(): void {
	if (!demoEnabled()) throw new Error("The demo is not enabled on this deployment");
}

/**
 * Visitors get a random address here. The domain is reserved for documentation, so it never
 * receives mail, and it is how cleanup tells a visitor from anyone else.
 */
export const VISITOR_DOMAIN = "visitors.example.com";

/** How long a sandbox lives before cleanup deletes it. */
export const SANDBOX_LIFETIME_MS = 24 * 60 * 60 * 1000;
