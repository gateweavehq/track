import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, unique } from "./helpers";

// Long enough that the list cannot draw every row at once: the rows near the screen, plus the
// overscan on each side, are about a third of them.
const COUNT = 120;

/** The list row (its checkbox and link) for an issue; `data-selected` sits on this element. */
function listRow(page: Page, title: string) {
	return page.locator("[data-checked]").filter({ has: issueRow(page, title) });
}

test("a long list renders only the rows near the screen, and the keyboard still reaches the rest", async ({
	page,
}) => {
	// Creating the issues takes a while, one dialog each.
	test.setTimeout(10 * 60_000);
	const { slug } = await startWorkspace(page);
	const titles: string[] = [];
	for (let index = 0; index < COUNT; index++) {
		const title = unique(`Long list ${String(index).padStart(3, "0")}`);
		titles.push(title);
		await createIssue(page, title);
	}
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, titles[0] as string)).toBeVisible();

	// Only the rows near the screen are in the page.
	const rendered = page.locator("[data-checked]");
	expect(await rendered.count()).toBeLessThan(COUNT);

	// J moves the selection down through rows that are not rendered yet; each one scrolls in.
	await issueRow(page, titles[0] as string).focus();
	for (let step = 0; step < 90; step++) await page.keyboard.press("j");
	await expect(listRow(page, titles[90] as string)).toHaveAttribute("data-selected", "true");
	await expect(issueRow(page, titles[90] as string)).toBeInViewport();
	expect(await rendered.count()).toBeLessThan(COUNT);

	// K moves back up, past rows that are off screen now.
	for (let step = 0; step < 72; step++) await page.keyboard.press("k");
	await expect(listRow(page, titles[18] as string)).toHaveAttribute("data-selected", "true");
	await expect(issueRow(page, titles[18] as string)).toBeInViewport();

	// The group header sticks at the top while its rows scroll beneath it.
	await expect(
		page
			.getByRole("heading")
			.filter({ hasText: /Todo|Backlog/ })
			.first(),
	).toBeInViewport();
	expect(await rendered.count()).toBeLessThan(COUNT);
});
