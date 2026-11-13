/**
 * Settings Track runs without (see src/server/env.d.ts). `secrets.required` in wrangler.jsonc
 * stops a deploy that lacks BETTER_AUTH_SECRET, but in local dev it also drops every other key
 * from .dev.vars. So in dev, these are added to the list when .dev.vars sets them.
 */
export const OPTIONAL_SECRETS = [
	"BETTER_AUTH_URL",
	"GITHUB_CLIENT_ID",
	"GITHUB_CLIENT_SECRET",
	"OIDC_ISSUER",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_PROVIDER_NAME",
	"EMAIL_FROM",
	"TURNSTILE_SITE_KEY",
	"TURNSTILE_SECRET_KEY",
	"INTAKE_EMAIL_DOMAIN",
	"ATTACHMENT_QUOTA_MB",
	"LEGAL_NOTICE_URL",
	"PRIVACY_POLICY_URL",
	"TERMS_URL",
	"SIGN_UP_REQUEST_URL",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_CLIENT_SECRET",
	"GITHUB_APP_WEBHOOK_SECRET",
	"PUSH_VAPID_KEY",
	// Local workerd has no jurisdictions: set, every workspace fails to open.
	"DURABLE_OBJECT_JURISDICTION",
	"TRACK_DEMO",
] as const;

/** What local dev loads from .dev.vars: the required secrets, and the optional ones it sets. */
export function devSecrets(required: readonly string[], set: ReadonlySet<string>): string[] {
	return [...required, ...OPTIONAL_SECRETS.filter((key) => set.has(key))];
}
