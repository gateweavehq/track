import { type Browser, type BrowserContext, test as base } from "@playwright/test";
import { Network } from "./network";

/**
 * Better Auth limits sign-ups and sign-ins to a few per 10 seconds per client address, and
 * identifies the client by Cloudflare's `cf-connecting-ip` header. Every request in a local run
 * comes from one address, so tests that sign up in parallel would be throttled (429). Each
 * browser context therefore presents itself as a different client, as real people would.
 */
function clientHeaders(): Record<string, string> {
	const octet = () => Math.floor(Math.random() * 256);
	return { "cf-connecting-ip": `10.${octet()}.${octet()}.${1 + (octet() % 254)}` };
}

export const test = base.extend<{ network: Network }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the pattern to see that no fixture is used
	extraHTTPHeaders: async ({}, use) => {
		await use(clientHeaders());
	},
	network: async ({ context }, use) => {
		await use(await Network.attach(context));
	},
});

export { expect } from "@playwright/test";

/** A second, separate browser: its own storage, cookies and client address. */
export function newBrowserContext(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({ extraHTTPHeaders: clientHeaders() });
}
