// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * Who email comes from, such as `Gateweave Track <track@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset.
		 */
		EMAIL_FROM?: string;
		/**
		 * Turnstile's site key and secret key, which turn on teams' public request forms. Without
		 * both, no form takes requests.
		 */
		TURNSTILE_SITE_KEY?: string;
		TURNSTILE_SECRET_KEY?: string;
		/**
		 * The domain whose Email Routing sends every address to this Worker, such as
		 * `requests.example.com`, which turns on teams' intake email addresses. Without it, they
		 * are off.
		 */
		INTAKE_EMAIL_DOMAIN?: string;
		/** "1" on the public demo deployment only (the `demo` environment in wrangler.jsonc). */
		TRACK_DEMO?: string;
	}
}
