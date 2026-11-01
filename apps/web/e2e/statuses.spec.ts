import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

test("an admin adds, renames and removes a team's statuses, and its issues follow", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const login = unique("Check the login flow");
	await createIssue(page, login);

	// Add Ready for QA after In Review, and call In Progress "Doing".
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("button", { name: "Statuses of Engineering" }).click();
	const workflow = page.getByRole("dialog", { name: "Statuses of Engineering" });
	await workflow.getByRole("button", { name: "Add a started status" }).click();
	const add = page.getByRole("dialog", { name: "Add status" });
	await add.getByLabel("Name").fill("Ready for QA");
	await add.getByRole("button", { name: "Add status" }).click();
	await expect(add).toBeHidden();

	await workflow.getByRole("button", { name: "Edit In Progress" }).click();
	const edit = page.getByRole("dialog", { name: "Edit In Progress" });
	await edit.getByLabel("Name").fill("Doing");
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(edit).toBeHidden();

	const started = workflow.getByRole("region", { name: "Started", exact: true });
	await expect(started.getByRole("listitem")).toHaveText([/^Doing/, /^In Review/, /^Ready for QA/]);
	// Move QA ahead of review.
	await started.getByRole("button", { name: "Move Ready for QA up" }).click();
	await expect(started.getByRole("listitem")).toHaveText([/^Doing/, /^Ready for QA/, /^In Review/]);
	// The last completed status stays.
	await expect(workflow.getByRole("button", { name: "Remove Done" })).toBeDisabled();
	await workflow.getByRole("button", { name: "Done", exact: true }).click();
	await expect(workflow).toBeHidden();

	// The board has a column for it, in the team's order, and the issue moves into it.
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Board", exact: true }).click();
	await expect(page.getByRole("main").getByRole("region").locator("h2")).toHaveText([
		"Backlog",
		"Todo",
		"Doing",
		"Ready for QA",
		"In Review",
		"Done",
		"Canceled",
	]);
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await page.getByRole("option", { name: "Ready for QA" }).click();
	await expect(properties.getByRole("button", { name: /^Ready for QA/ })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// Removing the status moves its issue to Done.
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("button", { name: "Statuses of Engineering" }).click();
	await workflow.getByRole("button", { name: "Remove Ready for QA" }).click();
	const remove = page.getByRole("dialog", { name: "Remove Ready for QA?" });
	await expect(remove).toContainText("Its one issue moves to another status");
	await remove.getByLabel("Move its issues to").selectOption({ label: "Done" });
	await remove.getByRole("button", { name: "Remove status" }).click();
	await expect(remove).toBeHidden();
	await expect(workflow.getByRole("button", { name: "Remove Ready for QA" })).toBeHidden();
	await workflow.getByRole("button", { name: "Done", exact: true }).click();

	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(properties.getByRole("button", { name: /^Done/ })).toBeVisible();
	// History joins one person's changes in a row: theirs, then the move.
	await expect(page.getByText("changed the status from Backlog to Done")).toBeVisible();

	// The status survives a reload from the server, as everyone's replica has it.
	await page.reload();
	await expect(properties.getByRole("button", { name: /^Done/ })).toBeVisible();
});
