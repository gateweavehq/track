import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

/** Ticks values of one filter in the filter menu, then closes the menu. */
async function filterBy(page: Page, filter: string, ...values: string[]) {
	await page.getByRole("button", { name: "Filter", exact: true }).click();
	await page.getByRole("option", { name: filter }).click();
	for (const value of values) await page.getByRole("option", { name: value }).click();
	await page.keyboard.press("Escape");
}

test("filters keep the issues that match, stay in the URL, and new issues match them", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const outage = unique("Fix the outage");
	const docs = unique("Tidy the docs");
	await createIssue(page, outage);
	await createIssue(page, docs);

	// Make the first one urgent and in progress, from its page.
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await page.getByRole("option", { name: "In Progress" }).click();
	await properties.getByRole("button", { name: /^No priority/ }).click();
	await page.getByRole("option", { name: "Urgent" }).click();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/team/ENG`);
	const chips = page.getByRole("group", { name: "Filters in force" });
	await page.getByRole("button", { name: "Filter", exact: true }).click();
	await page.getByRole("option", { name: "Status" }).click();
	await page.getByRole("option", { name: "In Progress" }).click();
	await page.getByRole("option", { name: "Todo" }).click();
	await expect(page).toHaveURL(/status=/);
	await expect(issueRow(page, outage)).toBeVisible();
	await expect(issueRow(page, docs)).toBeHidden();
	await expect(chips.getByTitle("Status: Todo, In Progress")).toBeVisible();
	await expect(page.getByTitle("1 of 2 issues")).toBeVisible();

	// The search keeps the focus after a click: Backspace goes back to the filters, and typing
	// finds a value of any of them. Filters add up, and survive a reload.
	await page.keyboard.press("Backspace");
	await page.keyboard.type("urgent");
	await page.getByRole("option", { name: "Priority: Urgent" }).click();
	await page.keyboard.press("Escape");
	await expect(chips.getByTitle("Priority: Urgent")).toBeVisible();
	await page.reload();
	await expect(chips.getByTitle("Priority: Urgent")).toBeVisible();
	await expect(issueRow(page, outage)).toBeVisible();
	await expect(issueRow(page, docs)).toBeHidden();

	// Removing one leaves the other.
	await page.getByRole("button", { name: "Remove the status filter" }).click();
	await expect(page).not.toHaveURL(/status=/);
	await expect(chips.getByTitle("Priority: Urgent")).toBeVisible();
	await expect(issueRow(page, docs)).toBeHidden();

	// An issue created here is urgent, so it shows up on the filtered page.
	const pager = unique("Page the on-call");
	await createIssue(page, pager);
	await expect(issueRow(page, pager)).toBeVisible();

	// Issues without an assignee, which is all of them; then everything again.
	await filterBy(page, "Assignee", "No assignee");
	await expect(chips.getByTitle("Assignee: No assignee")).toBeVisible();
	await expect(issueRow(page, outage)).toBeVisible();
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(issueRow(page, docs)).toBeVisible();
	await expect(page.getByTitle(/issues$/)).toHaveCount(0);
});
