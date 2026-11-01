import { expect, test } from "./fixtures";
import { startWorkspace, syncBadge } from "./helpers";

test("an admin sets a team's automations, and its archive says when issues arrive", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("button", { name: "Automations for Engineering" }).click();
	const dialog = page.getByRole("dialog", { name: "Automations for Engineering" });
	const archive = dialog.getByLabel("Archive closed issues");
	const close = dialog.getByLabel("Close stale issues");
	await expect(archive).toHaveValue("off");
	await expect(close).toHaveValue("off");

	// Before saving, each rule says what its first run would do.
	await archive.selectOption("6");
	await expect(dialog.getByText("No issues would be archived today.")).toBeVisible();
	await close.selectOption("12");
	await expect(
		dialog.getByText(/move to Canceled\. .*No issues would be closed today\./),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.reload();
	await page.getByRole("button", { name: "Automations for Engineering" }).click();
	await expect(archive).toHaveValue("6");
	await expect(close).toHaveValue("12");
	await dialog.getByRole("button", { name: "Cancel" }).click();

	await page.goto(`/${slug}/team/ENG/archive`);
	await expect(
		page.getByText("Completed and canceled issues come here after 6 months untouched"),
	).toBeVisible();
});
