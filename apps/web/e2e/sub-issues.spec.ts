import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("an issue breaks down into sub-issues, whose progress shows on the parent", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const parent = unique("Launch the site");
	const loose = unique("Pick a domain");
	await createIssue(page, parent);
	await createIssue(page, loose);
	await expect(issueRow(page, loose)).toBeVisible();

	// Add a sub-issue from the parent's page; the field stays open for the next one.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Add sub-issue" }).click();
	const field = page.getByLabel("New sub-issue title");
	const child = unique("Write the copy");
	await field.fill(child);
	await field.press("Enter");
	const subIssues = page.getByRole("region", { name: "Sub-issues" });
	await expect(subIssues.getByRole("link", { name: child })).toBeVisible();
	await expect(subIssues.getByTitle("Done, out of all that are not canceled")).toHaveText("0/1");
	await expect(field).toHaveValue("");
	await field.press("Escape");

	// Put an existing issue under it with the parent picker.
	await page.goto(`/${slug}/issue/ENG-2`);
	await page.getByRole("button", { name: "No parent" }).click();
	await page.getByPlaceholder("Set parent issue…").fill("ENG-1");
	await page.getByRole("option", { name: parent }).click();
	await expect(page.getByRole("link", { name: /Sub-issue of ENG-1/ })).toBeVisible();
	await expect(page.getByText("made the issue a sub-issue of")).toBeVisible();

	// Finish one sub-issue from the parent's list of them.
	await page.getByRole("link", { name: /Sub-issue of ENG-1/ }).click();
	await expect(subIssues.getByRole("link")).toHaveCount(2);
	await subIssues.getByRole("button", { name: "Status: Backlog" }).first().click();
	await page.getByRole("option", { name: "Done" }).click();
	await expect(subIssues.getByTitle("Done, out of all that are not canceled")).toHaveText("1/2");
	await expect(syncBadge(page)).toHaveText("Live");

	// The team's list shows the parent's progress.
	await page.goto(`/${slug}/team/ENG`);
	await expect(page.getByTitle("Sub-issues: 1 of 2 done")).toBeVisible();

	// Deleting the parent keeps its sub-issues.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Delete issue" }).click();
	await page.getByRole("button", { name: "Delete issue" }).last().click();
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("button", { name: "No parent" })).toBeVisible();
	await expect(page.getByRole("link", { name: /Sub-issue of/ })).toHaveCount(0);
});
