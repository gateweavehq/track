import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("several issues are picked in a list and changed, then deleted, at once", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const titles = [unique("Fix the login form"), unique("Update the docs"), unique("Tidy the CSS")];
	for (const title of titles) await createIssue(page, title);
	const [login, docs, css] = titles as [string, string, string];
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, css)).toBeVisible();

	// One by its checkbox, one from the keyboard.
	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await expect(bar).toContainText("1 issue selected");
	await issueRow(page, docs).focus();
	await page.keyboard.press("x");
	await expect(bar).toContainText("2 issues selected");

	// P opens the bar's priority menu, which sets both.
	await page.keyboard.press("p");
	await page.getByRole("option", { name: "High" }).click();
	for (const key of ["ENG-1", "ENG-2"]) {
		const row = page.locator("[data-checked]", {
			has: page.getByRole("checkbox", { name: `Select ${key}` }),
		});
		await expect(row.getByRole("button", { name: "Priority: High" })).toBeVisible();
	}
	const third = page.locator("[data-checked]", {
		has: page.getByRole("checkbox", { name: "Select ENG-3" }),
	});
	await expect(third.getByRole("button", { name: "Priority: No priority" })).toBeVisible();

	// A label goes on both.
	await bar.getByRole("button", { name: "Labels" }).click();
	await page.getByPlaceholder(/label/i).fill("Frontend");
	await page.getByRole("option", { name: /Create.*Frontend/ }).click();
	await page.keyboard.press("Escape");
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("complementary", { name: "Properties" })).toContainText("Frontend");
	await page.goto(`/${slug}/team/ENG`);

	// Esc clears the selection; then everything up to the last is picked with Shift.
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click();
	await page.keyboard.press("Escape");
	await expect(bar).toBeHidden();
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click({ modifiers: ["Shift"] });
	await expect(bar).toContainText("3 issues selected");

	await bar.getByRole("button", { name: "Delete 3 issues" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	for (const title of [login, docs, css]) await expect(issueRow(page, title)).toBeHidden();
	await expect(bar).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");
});
