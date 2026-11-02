import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("a closed issue is archived out of lists, found in the team's archive, and restored", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const shipped = unique("Ship the login page");
	const open = unique("Write the onboarding guide");
	await createIssue(page, shipped);
	await createIssue(page, open);

	// An open issue cannot be archived, so its page offers no way to.
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("button", { name: "Archive issue" })).toBeHidden();
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await page.getByRole("option", { name: "Done" }).click();
	await page.getByRole("button", { name: "Archive issue" }).click();

	// Archived, its page has what the browser keeps of it, and says the rest is on the server.
	await expect(page.getByRole("status").filter({ hasText: /^Archived/ })).toBeVisible();
	await expect(page.getByRole("heading", { name: shipped })).toBeVisible();
	await expect(page.getByText("comes in a later version of Track")).toBeVisible();
	await expect(page.getByText("changed the status")).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");

	// The team's list leaves it out, and links to the archive, which has it.
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, open)).toBeVisible();
	await expect(issueRow(page, shipped)).toBeHidden();
	await page.getByRole("link", { name: "Engineering archive, 1 issues" }).click();
	const archive = page.getByRole("list", { name: "Engineering archive" });
	await expect(archive.getByRole("listitem")).toHaveCount(1);
	await expect(archive.getByRole("link")).toContainText(shipped);

	// Restored, it is back in the list.
	await archive.getByRole("button", { name: "Restore ENG-1" }).click();
	await expect(page.getByRole("heading", { name: "Nothing archived" })).toBeVisible();
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, shipped)).toBeVisible();

	// Archived again, then restored from its own page: the whole issue comes back, history too.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Archive issue" }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Archived/ })).toBeVisible();
	await page.getByRole("button", { name: "Restore" }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Archived/ })).toBeHidden();
	await expect(page.getByText("changed the status")).toBeVisible();
	await expect(page.getByRole("button", { name: "Archive issue" })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, shipped)).toBeVisible();
});
