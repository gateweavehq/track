import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

test("an issue's Labels menu creates a label that does not exist yet, and adds it", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Fix the footer"));
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });

	// The workspace has no labels yet, so nothing matches what is typed.
	await properties.getByRole("button", { name: "Add labels" }).click();
	await page.getByPlaceholder("Add labels…").fill("Bug");
	await page.getByRole("option", { name: "Create label “Bug”" }).click();
	await expect(page.getByRole("option", { name: "Bug" })).toBeVisible();

	// Now a label exists that does not match: creating another is still offered.
	await page.getByPlaceholder("Add labels…").fill("Docs");
	await page.getByRole("option", { name: "Create label “Docs”" }).click();
	await page.keyboard.press("Escape");
	await expect(properties.getByText("Bug")).toBeVisible();
	await expect(properties.getByText("Docs")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
});
