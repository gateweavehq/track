import { expect, test } from "./fixtures";
import { startWorkspace, waitForServiceWorker } from "./helpers";

// The end-to-end build sets the addresses (vite.config.ts). What reaches the page before its script
// is in test/legal-links.test.ts: this is what only exists after signing in.

test("the workspace menu links the legal pages, with a connection and without", async ({
	page,
	network,
}) => {
	const { name } = await startWorkspace(page);
	await waitForServiceWorker(page);

	const expectLinks = async () => {
		await page.getByRole("button", { name }).click();
		for (const [words, address] of [
			["Legal notice", "https://legal.example/notice"],
			["Privacy", "https://legal.example/privacy"],
			["Terms", "https://legal.example/terms"],
		] as const) {
			await expect(page.getByRole("menuitem", { name: words, exact: true })).toHaveAttribute(
				"href",
				address,
			);
		}
		await page.keyboard.press("Escape");
	};
	await expectLinks();

	await network.goOffline();
	await page.reload();
	await expectLinks();
	await network.goOnline();

	await page.goto("/");
	const legal = page.getByRole("navigation", { name: "Legal" });
	await expect(legal.getByRole("link", { name: "Terms", exact: true })).toHaveAttribute(
		"href",
		"https://legal.example/terms",
	);
	await expect(page.getByRole("link", { name })).toBeVisible();
});
