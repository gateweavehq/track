import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("issues block, duplicate and relate to each other, from both sides", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const api = unique("Ship the API");
	const mockups = unique("Draw the mockups");
	await createIssue(page, api);
	await createIssue(page, mockups);
	await expect(issueRow(page, mockups)).toBeVisible();

	// The API waits for the mockups.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Add relation" }).click();
	await page.getByRole("option", { name: "Blocked by…" }).click();
	await page.getByPlaceholder("Find the issue that blocks it…").fill("ENG-2");
	await page.getByRole("option", { name: mockups }).click();
	const blockedBy = page.getByRole("list", { name: "Blocked by" });
	await expect(blockedBy.getByRole("link", { name: mockups })).toBeVisible();
	await expect(page.getByText("marked the issue as blocked by")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The list marks it as blocked while the mockups are open.
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, api)).toBeVisible();
	// Only the API is blocked; the mockups block it.
	await expect(page.getByTitle("Blocked by an open issue")).toHaveCount(1);

	// The other side sees what it blocks; a new relation between the two replaces it.
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("list", { name: "Blocks" }).getByRole("link")).toHaveText(
		new RegExp(api),
	);
	await page.getByRole("button", { name: "Add relation" }).click();
	await page.getByRole("option", { name: "Duplicate of…" }).click();
	await page.getByPlaceholder("Find the issue it duplicates…").fill(api);
	await page.getByRole("option", { name: api }).click();
	await expect(page.getByRole("list", { name: "Duplicate of" }).getByRole("link")).toHaveText(
		new RegExp(api),
	);
	await expect(page.getByRole("list", { name: "Blocks" })).toHaveCount(0);

	// A duplicate closes in one click.
	await page.getByRole("button", { name: "Close as duplicate" }).click();
	await expect(page.getByText("changed the status from Backlog to")).toBeVisible();
	await expect(page.getByRole("button", { name: "Close as duplicate" })).toHaveCount(0);

	// Removing the relation leaves both issues on their own.
	await page.getByRole("button", { name: "Remove relation to ENG-1" }).click();
	await expect(page.getByRole("region", { name: "Relations" })).toHaveCount(0);
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("region", { name: "Relations" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Add relation" })).toBeVisible();
});
