import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("a due date and an estimate show on the list, and the due filter finds what is late", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const late = unique("Renew the domain");
	const undated = unique("Plan the offsite");
	await createIssue(page, late);
	await createIssue(page, undated);
	await expect(issueRow(page, undated)).toBeVisible();

	// Give the first issue a due date long past and an estimate, from its page.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByLabel("Due date").fill("2020-01-15");
	await page.getByRole("button", { name: "No estimate" }).click();
	await page.getByRole("option", { name: "3 points", exact: true }).click();
	await expect(page.getByRole("button", { name: "3 points", exact: true })).toBeVisible();
	await expect(page.getByText("set the due date to")).toBeVisible();
	await expect(page.getByText("estimated the issue at")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The list shows both, and says the issue is overdue.
	await page.goto(`/${slug}/team/ENG`);
	await expect(page.getByTitle(/^Overdue, due/)).toHaveCount(1);
	await expect(page.getByTitle("Estimate: 3 points")).toHaveCount(1);

	// The filter keeps only overdue issues, in the URL, and clears.
	await page.getByRole("button", { name: "Filter by due date" }).click();
	await page.getByRole("menuitemradio", { name: "Overdue" }).click();
	await expect(page).toHaveURL(/due=overdue/);
	await expect(issueRow(page, late)).toBeVisible();
	await expect(issueRow(page, undated)).toBeHidden();
	await page.getByRole("button", { name: "Clear the due date filter" }).click();
	await expect(issueRow(page, undated)).toBeVisible();

	// Clearing the date on the issue page takes it off the list.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Clear the due date" }).click();
	await expect(page.getByText("removed the due date")).toBeVisible();
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, late)).toBeVisible();
	await expect(page.getByTitle(/^Overdue, due/)).toHaveCount(0);
});
