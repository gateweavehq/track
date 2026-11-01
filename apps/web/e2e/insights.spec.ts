import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

test("a team's insights count what it created and closed, and how long work took", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Ship the login page"));
	await createIssue(page, unique("Write the onboarding guide"));

	// Started, then done. The priority in between keeps the two steps apart in history, which
	// merges one person's quick changes to a field.
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await page.getByRole("option", { name: "In Progress" }).click();
	await properties.getByRole("button", { name: /^No priority/ }).click();
	await page.getByRole("option", { name: "Urgent" }).click();
	await properties.getByRole("button", { name: /^In Progress/ }).click();
	await page.getByRole("option", { name: "Done" }).click();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("link", { name: "Engineering insights" }).click();
	await expect(page.getByRole("heading", { name: "Insights" })).toBeVisible();
	const stat = (name: string) => page.getByRole("term").filter({ hasText: name }).locator("+ dd");
	await expect(stat("Open now")).toHaveText("1");
	await expect(stat("Created")).toHaveText("2");
	await expect(stat("Closed")).toHaveText("1");
	await expect(stat("Median cycle time")).toHaveText("1 hour");

	const byStatus = page.getByRole("region", { name: "Open by status" });
	await expect(byStatus.getByRole("listitem")).toHaveCount(1);
	await expect(byStatus.getByRole("listitem")).toContainText("Backlog");

	// The range is in the address.
	await page.getByRole("button", { name: "4 weeks" }).click();
	await expect(page).toHaveURL(/\?weeks=4$/);
	await expect(page.getByRole("button", { name: "4 weeks" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.reload();
	await expect(page.getByRole("button", { name: "4 weeks" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(
		page.getByRole("table", { name: "Issues created and closed by week" }),
	).toBeAttached();
});
