// Where the public demo sends visitors. One place, so the destinations can change without
// touching the components that show them.

export const REPOSITORY_URL = "https://github.com/gateweavehq/track";
export const SELF_HOSTING_URL = `${REPOSITORY_URL}/blob/main/docs/self-hosting.md`;
/** The product page, which carries Gateweave Cloud's current way in; never a sign-up page. */
export const CLOUD_URL = "https://gateweave.com/track";
export const CLOUD_TOOLTIP = "Hosted for you in the EU";

/**
 * The sample issue that shows an agent member's work, which the welcome card points to. The
 * sample files it last in the Design team (`AGENT_EXAMPLE` in server/demo/sample-data.ts), which
 * is what gives it this key; a test there holds the two together.
 */
export const AGENT_EXAMPLE_ISSUE_KEY = "DES-11";
