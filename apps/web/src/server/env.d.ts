// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * An OpenID Connect provider to sign in through: its issuer URL and this deployment's client
		 * id and secret there. Needs all three. See docs/self-hosting.md.
		 */
		OIDC_ISSUER?: string;
		OIDC_CLIENT_ID?: string;
		OIDC_CLIENT_SECRET?: string;
		/** What the sign-in button calls it, as in "Continue with Gateweave". */
		OIDC_PROVIDER_NAME?: string;
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
		 * The addresses of this deployment's legal pages, linked from the sign-in pages, the
		 * workspace menu and the public request form. Each is left out when unset, or when it is not
		 * an http(s) address.
		 */
		LEGAL_NOTICE_URL?: string;
		PRIVACY_POLICY_URL?: string;
		TERMS_URL?: string;
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
		/**
		 * Where someone can ask for an account, an https address such as
		 * `https://example.com/waitlist`. While the server's owner has closed sign-up, the sign-in
		 * page links to it as "Ask for access". Left out when unset or not an https address.
		 */
		SIGN_UP_REQUEST_URL?: string;
		/**
		 * The key this server signs push notifications with (VAPID): a P-256 private key as a JWK,
		 * which `node apps/web/scripts/push-key.mjs` makes. Push is off when unset. Changing it
		 * makes every browser turn push on again.
		 */
		PUSH_VAPID_KEY?: string;
		/**
		 * One of Cloudflare's jurisdictions, such as `eu`, to keep each workspace's Durable Object
		 * in. New workspaces are made there, and the daily run moves existing ones there, each one
		 * paused for a few seconds. Unset, new workspaces go wherever Cloudflare puts them and none
		 * move. Local runtimes have no jurisdictions. See docs/self-hosting.md.
		 */
		DURABLE_OBJECT_JURISDICTION?: string;
		/** "1" on the public demo deployment only (the `demo` environment in wrangler.jsonc). */
		TRACK_DEMO?: string;
	}
}
