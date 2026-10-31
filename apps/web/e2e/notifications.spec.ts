import { expect, test } from "./fixtures";
import { startWorkspace } from "./helpers";

test("a person chooses what reaches their inbox and their email", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings`);
	await page.getByRole("link", { name: "Notifications" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/settings/notifications$`));

	const settings = page.getByRole("list", { name: "Notification settings" });
	await expect(settings.getByRole("combobox", { name: "Assigned to you" })).toHaveValue("email");
	await expect(settings.getByRole("combobox", { name: "Status changes" })).toHaveValue("inbox");

	await settings.getByRole("combobox", { name: "Status changes" }).selectOption("off");
	await settings.getByRole("combobox", { name: "Comments" }).selectOption("inbox");
	await page.reload();
	await expect(settings.getByRole("combobox", { name: "Status changes" })).toHaveValue("off");
	await expect(settings.getByRole("combobox", { name: "Comments" })).toHaveValue("inbox");
	await expect(settings.getByRole("combobox", { name: "Assigned to you" })).toHaveValue("email");
});
