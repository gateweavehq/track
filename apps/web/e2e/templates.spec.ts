import { expect, test } from "./fixtures";
import { issueRow, startWorkspace, syncBadge } from "./helpers";

test("a team's template starts new issues, from the palette and from the create dialog", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/templates`);
	await expect(page.getByText("No templates yet.")).toBeVisible();

	await page.getByRole("button", { name: "Create template" }).click();
	const editor = page.getByRole("dialog", { name: "Create template" });
	await editor.getByLabel("Name").fill("Bug report");
	await editor.getByLabel("Issue title").fill("Bug: ");
	await editor.getByLabel("Description").fill("## Steps to reproduce");
	await editor.getByRole("button", { name: "Priority" }).click();
	await page.getByRole("option", { name: "High" }).click();
	await editor.getByRole("button", { name: "Create template" }).click();
	await expect(editor).toBeHidden();
	const templates = page.getByRole("list", { name: "Engineering templates" });
	await expect(templates.getByRole("listitem")).toContainText("Bug report");
	await expect(syncBadge(page)).toHaveText("Live");

	// A name the team already uses is refused before anything is sent.
	await page.getByRole("button", { name: "Create template" }).click();
	await editor.getByLabel("Name").fill("BUG REPORT");
	await editor.getByRole("button", { name: "Create template" }).click();
	await expect(editor.getByRole("alert")).toHaveText(
		"Engineering already has a template named BUG REPORT",
	);
	await editor.getByRole("button", { name: "Cancel" }).click();

	// From the palette: the issue starts with the template's title, description and priority.
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "Command palette" });
	await palette.getByPlaceholder("Search issues or type a command…").fill("from Bug report");
	await palette.getByRole("option", { name: "Create issue from Bug report" }).click();
	const draft = page.getByRole("dialog", { name: "New issue" });
	await expect(draft.getByLabel("Title")).toHaveValue("Bug: ");
	await expect(draft.getByLabel("Description")).toHaveValue("## Steps to reproduce");
	await expect(draft.getByRole("button", { name: "Bug report" })).toBeVisible();
	await draft.getByLabel("Title").fill("Bug: Login fails on Safari");
	await draft.getByRole("button", { name: "Create issue" }).click();
	await expect(draft).toBeHidden();

	await page.goto(`/${slug}/team/ENG`);
	await issueRow(page, "Bug: Login fails on Safari").click();
	const properties = page.getByRole("complementary", { name: "Properties" });
	await expect(properties.getByRole("button", { name: /^High/ })).toBeVisible();
	await expect(page.getByText("Steps to reproduce")).toBeVisible();

	// From the create dialog: what was typed gives way to what the template has.
	await page.getByRole("button", { name: "New issue" }).first().click();
	await draft.getByLabel("Title").fill("Crash on save");
	await draft.getByLabel("Description").fill("It crashes");
	await draft.getByRole("button", { name: "Template" }).click();
	await page.getByRole("menuitem", { name: "Bug report" }).click();
	await expect(draft.getByLabel("Title")).toHaveValue("Bug: ");
	await expect(draft.getByLabel("Description")).toHaveValue("## Steps to reproduce");

	// Deleting the template leaves the issues made from it.
	await page.goto(`/${slug}/settings/templates`);
	await page.getByRole("button", { name: "Delete Bug report" }).click();
	await page.getByRole("button", { name: "Delete template" }).click();
	await expect(page.getByText("No templates yet.")).toBeVisible();
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, "Bug: Login fails on Safari")).toBeVisible();
});
