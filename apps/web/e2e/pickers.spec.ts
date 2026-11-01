import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

// A picker that closes hands focus back to its button a moment after it leaves the page. Someone
// who opened the next picker in that moment, as a test on a slow machine did, lost it: the focus
// moved out of the new picker, which closed it.
test("a picker opened just as the last one closes stays open", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Tidy the settings"));
	await page.goto(`/${slug}/issue/ENG-1`);

	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await expect(page.getByRole("option", { name: "Todo" })).toBeVisible();
	const priority = await properties.getByRole("button", { name: /^No priority/ }).elementHandle();
	await page.evaluate((trigger) => {
		const picker = document.querySelector("[data-radix-popper-content-wrapper]");
		if (!(picker && trigger instanceof HTMLElement)) throw new Error("No open picker");
		new MutationObserver((_, observer) => {
			if (picker.isConnected) return;
			observer.disconnect();
			// What a mouse does on the priority button, the moment the status picker is gone.
			trigger.focus();
			trigger.click();
		}).observe(document.body, { childList: true, subtree: true });
	}, priority);
	await page.getByRole("option", { name: "Todo" }).click();
	await expect(page.getByRole("option", { name: "High" })).toBeVisible();

	// Long enough for the status picker to have handed focus back, had it still been going to.
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
	await expect(page.getByRole("option", { name: "High" })).toBeVisible();
	await page.getByRole("option", { name: "High" }).click();
	await expect(properties.getByRole("button", { name: /^High/ })).toBeVisible();
	await expect(properties.getByRole("button", { name: /^Todo/ })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
});
