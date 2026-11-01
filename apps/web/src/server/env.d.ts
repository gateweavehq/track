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
		/**
		 * The most megabytes of attached files each workspace may keep, such as `1024`. Uploads
		 * past it are refused, and an emailed request's attachments past it are left out.
		 * Unlimited when unset.
		 */
		ATTACHMENT_QUOTA_MB?: string;
		/**
		 * The deployment's GitHub App, which admins install on their repositories instead of adding
		 * a webhook by hand: its URL name (`github.com/apps/<slug>`), its OAuth client id and
		 * secret, which show GitHub's word on who may reach an installation, and the secret that
		 * signs its deliveries. Without all four, the app is off and webhooks still work.
		 */
		GITHUB_APP_SLUG?: string;
		GITHUB_APP_CLIENT_ID?: string;
		GITHUB_APP_CLIENT_SECRET?: string;
		GITHUB_APP_WEBHOOK_SECRET?: string;
		/** "1" on the public demo deployment only (the `demo` environment in wrangler.jsonc). */
		TRACK_DEMO?: string;
	}
}
