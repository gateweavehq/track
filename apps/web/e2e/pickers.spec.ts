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

// A picker that closed used to fade out, and stayed on the page until it had. A click in that
// moment on what it still covered, such as the next row's picker in a table, went to the fading
// picker and was lost, and its options were still there for screen readers (and tests) to find.
test("a click on the next picker just as the last one closes opens it", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const first = unique("Sort the inbox");
	const second = unique("Answer the mail");
	await createIssue(page, first);
	await createIssue(page, second);
	await page.goto(`/${slug}/team/ENG?view=table`);
	const priorityOf = (title: string) =>
		page
			.getByRole("row")
			.filter({ hasText: title })
			.getByRole("button", { name: /^Priority: / });

	await priorityOf(first).click();
	const box = await priorityOf(second).boundingBox();
	if (!box) throw new Error("No priority button");
	await page.getByRole("option", { name: "High" }).click();
	// At once, as a person does, rather than waiting for the first picker to go as Playwright would.
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(priorityOf(second)).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("option", { name: "Urgent" }).click();
	await expect(priorityOf(second)).toHaveAccessibleName("Priority: Urgent");
	await expect(priorityOf(first)).toHaveAccessibleName("Priority: High");
	await expect(syncBadge(page)).toHaveText("Live");
});
