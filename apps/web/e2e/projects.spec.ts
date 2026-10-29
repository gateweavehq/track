import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

/** The sidebar link, since a project's page links back to the list too. */
function projectsLink(page: Page) {
	return page.getByRole("complementary").getByRole("link", { name: "Projects" });
}

test("a project groups issues, and its progress shows on the projects page", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const first = unique("Write the guide");
	await createIssue(page, first);
	await expect(issueRow(page, first)).toBeVisible();

	// No projects yet.
	await projectsLink(page).click();
	await expect(page).toHaveURL(`/${slug}/projects`);
	await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();

	// Create one. The app opens it.
	const name = unique("Launch");
	await page.getByRole("button", { name: "New project" }).first().click();
	const dialog = page.getByRole("dialog", { name: "New project" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create project" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/project/[^/]+$`));
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	await expect(page.getByRole("heading", { name: "No issues in this project" })).toBeVisible();

	// Set it on an issue from the issue page.
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "No project" }).click();
	await page.getByRole("option", { name }).click();
	await expect(page.getByRole("button", { name })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The issue is on the project page, and a new issue made there starts in the project.
	await projectsLink(page).click();
	await page.getByRole("link", { name }).click();
	await expect(issueRow(page, first)).toBeVisible();
	const second = unique("Record a demo");
	await page.getByRole("button", { name: "New issue" }).first().click();
	const issueDialog = page.getByRole("dialog", { name: "New issue" });
	await expect(issueDialog.getByRole("button", { name })).toBeVisible();
	await issueDialog.getByLabel("Title").fill(second);
	await issueDialog.getByRole("button", { name: "Create issue" }).click();
	await expect(issueDialog).toBeHidden();
	await expect(issueRow(page, second)).toBeVisible();

	// Progress is done over all issues that are not canceled.
	await projectsLink(page).click();
	await expect(page.getByTestId("project-progress")).toHaveText("0/2");
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Backlog" }).click();
	await page.getByRole("option", { name: "Done" }).click();
	await expect(syncBadge(page)).toHaveText("Live");
	await projectsLink(page).click();
	await expect(page.getByTestId("project-progress")).toHaveText("1/2");

	// Deleting the project (the creator is the owner) leaves its issues without one.
	await page.getByRole("link", { name }).click();
	await page.getByRole("button", { name: "Delete project" }).click();
	await page.getByRole("button", { name: "Delete project" }).last().click();
	await expect(page).toHaveURL(`/${slug}/projects`);
	await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("button", { name: "No project" })).toBeVisible();
});
