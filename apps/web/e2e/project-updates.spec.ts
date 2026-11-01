import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { startWorkspace, syncBadge, unique } from "./helpers";

/** Picks a health as people do, by its label: the radio itself is visually hidden. */
async function pickHealth(page: Page, health: string) {
	const updates = page.getByRole("region", { name: "Updates" });
	await updates.locator("label").filter({ hasText: health }).click();
	await expect(updates.getByRole("radio", { name: health })).toBeChecked();
}

async function postUpdate(page: Page, health: string, body: string) {
	const updates = page.getByRole("region", { name: "Updates" });
	await updates.getByRole("button", { name: "Post update" }).click();
	await pickHealth(page, health);
	await updates.getByRole("textbox", { name: "Update" }).fill(body);
	await updates.getByRole("button", { name: "Post update" }).click();
}

test("a project's updates say how it is going, the latest on the projects page", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const name = unique("Launch");
	await page.goto(`/${slug}/projects`);
	await page.getByRole("button", { name: "New project" }).first().click();
	const dialog = page.getByRole("dialog", { name: "New project" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create project" }).click();
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

	const updates = page.getByRole("region", { name: "Updates" });
	await expect(updates).toContainText("No updates yet");
	await postUpdate(page, "At risk", "The **API** is late.");
	const list = updates.getByRole("list", { name: `${name} updates` });
	await expect(list.getByRole("article")).toHaveCount(1);
	await expect(list.getByRole("article")).toContainText("At risk");
	await expect(list.getByRole("strong")).toHaveText("API");

	// A second one is the latest; the first is a click away.
	await postUpdate(page, "On track", "Caught up.");
	await expect(list.getByRole("article")).toHaveCount(1);
	await expect(list.getByRole("article")).toContainText("Caught up.");
	await updates.getByRole("button", { name: "Show 1 earlier update" }).click();
	await expect(list.getByRole("article")).toHaveCount(2);

	// The author edits it.
	await list
		.getByRole("article")
		.first()
		.getByRole("button", { name: /^More for the update/ })
		.click();
	await page.getByRole("menuitem", { name: "Edit" }).click();
	await pickHealth(page, "Off track");
	await updates.getByRole("button", { name: "Save" }).click();
	await expect(list.getByRole("article").first()).toContainText("Off track");
	await expect(list.getByRole("article").first()).toContainText("(edited)");
	await expect(syncBadge(page)).toHaveText("Live");

	// The projects page shows the latest health, after a reload too.
	await page.goto(`/${slug}/projects`);
	await page.reload();
	await expect(page.getByRole("list", { name: "Projects" }).getByRole("listitem")).toContainText(
		"Off track",
	);
});
