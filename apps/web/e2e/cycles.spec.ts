import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("a team works in cycles: plan issues into the current one, filter by it, then stop", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const planned = unique("Ship the importer");
	const later = unique("Rewrite the docs");
	await createIssue(page, planned);
	await createIssue(page, later);

	// An admin turns cycles on, starting today, in the browser's time zone.
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("button", { name: "Cycles for Engineering" }).click();
	const settings = page.getByRole("dialog", { name: "Cycles for Engineering" });
	await settings.getByLabel("Work in cycles").click();
	const today = await page.evaluate(() => new Intl.DateTimeFormat("en-CA").format(new Date()));
	await settings.getByLabel("Next cycle starts").fill(today);
	await settings.getByRole("button", { name: "Save" }).click();
	await expect(settings).toBeHidden();

	// The workspace makes the cycle and two more ahead; the sidebar links to them.
	await page.getByRole("link", { name: "Engineering cycles" }).click();
	await expect(page).toHaveURL(`/${slug}/team/ENG/cycles`);
	await expect(page.getByRole("region", { name: "Current" }).getByRole("link")).toHaveText(
		"Cycle 1",
	);
	await expect(page.getByRole("region", { name: "Upcoming" }).getByRole("link")).toHaveText([
		"Cycle 2",
		"Cycle 3",
	]);

	// Plan the first issue into the current cycle, from its page.
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: "No cycle" }).click();
	await page.getByRole("option", { name: /^Cycle 1/ }).click();
	await expect(properties.getByRole("button", { name: "Cycle 1" })).toBeVisible();
	await expect(page.getByText("added the issue to")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The cycle's page lists it, and an issue made there joins the cycle.
	await page.goto(`/${slug}/team/ENG/cycles`);
	await page.getByRole("link", { name: "Cycle 1" }).click();
	await expect(issueRow(page, planned)).toBeVisible();
	await expect(issueRow(page, later)).toBeHidden();
	await expect(page.getByTestId("cycle-progress")).toHaveText("0/1 done");
	await expect(page.getByRole("img", { name: /^Burn-up: 0 of 1 issues done/ })).toBeVisible();
	const added = unique("Write the release notes");
	await page.getByRole("button", { name: "New issue" }).last().click();
	const dialog = page.getByRole("dialog", { name: "New issue" });
	await expect(dialog.getByRole("button", { name: "Cycle 1" })).toBeVisible();
	await dialog.getByLabel("Title").fill(added);
	await dialog.getByRole("button", { name: "Create issue" }).click();
	await expect(dialog).toBeHidden();
	await expect(issueRow(page, added)).toBeVisible();
	await expect(page.getByTestId("cycle-progress")).toHaveText("0/2 done");

	// Any member can name a cycle.
	const name = page.getByRole("textbox", { name: "Name" });
	await name.fill("Launch week");
	await name.press("Enter");
	await expect(page.getByRole("heading", { name: "Launch week", level: 1 })).toBeVisible();

	// The team's issues filter to the current cycle.
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Filter", exact: true }).click();
	await page.getByRole("option", { name: "Cycle" }).click();
	await page.getByRole("option", { name: "Current cycle" }).click();
	await page.keyboard.press("Escape");
	await expect(issueRow(page, planned)).toBeVisible();
	await expect(issueRow(page, added)).toBeVisible();
	await expect(issueRow(page, later)).toBeHidden();

	// Turning cycles off ends the current cycle today; its unfinished issues leave it.
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("button", { name: "Cycles for Engineering" }).click();
	await settings.getByLabel("Work in cycles").click();
	await settings.getByRole("button", { name: "Turn off cycles" }).click();
	await expect(settings).toBeHidden();
	await expect(page.getByRole("link", { name: "Engineering cycles" })).toBeHidden();
	await page.goto(`/${slug}/team/ENG/cycles`);
	await expect(
		page.getByRole("heading", { name: "Engineering does not work in cycles" }),
	).toBeVisible();
	const completed = page.getByRole("region", { name: "Completed" });
	await expect(completed.getByRole("link")).toHaveText(/Launch week/);
	await expect(page.getByRole("region", { name: "Upcoming" })).toBeHidden();
	// The issue is in no cycle now, and the team plans in none, so the property is gone.
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(properties.getByText("Cycle", { exact: true })).toBeHidden();
	await expect(properties.getByText("Project", { exact: true })).toBeVisible();
});
