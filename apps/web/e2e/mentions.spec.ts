import type { Page } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import { createIssue, joinByInvitation, startWorkspace, unique } from "./helpers";

function inboxLink(page: Page) {
	return page.getByRole("link", { name: /^Inbox(, \d+ unread)?$/ }).first();
}

test("an @ in a comment mentions a member, who hears of it in their inbox", async ({
	page,
	browser,
}) => {
	const workspace = await startWorkspace(page);
	const { slug, person: owner } = workspace;
	const title = unique("Rotate the signing keys");
	await createIssue(page, title);

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		const guest = await joinByInvitation(page, guestPage, workspace);
		await guestPage.goto(`/${slug}/inbox`);
		await expect(guestPage.getByText("You're all caught up")).toBeVisible();

		await page.goto(`/${slug}/issue/ENG-1`);
		const box = page.getByRole("textbox", { name: "Comment", exact: true });
		await box.click();
		// Names are "Test guest-…" and "Test user-…": a word of the guest's finds them alone.
		await box.pressSequentially("Can you take this, @guest");
		const menu = page.getByRole("listbox", { name: "People to mention" });
		await expect(menu.getByRole("option")).toHaveCount(1);
		await expect(menu.getByRole("option", { name: guest.name, exact: true })).toBeVisible();
		await box.press("Enter");
		await expect(menu).toBeHidden();
		await box.pressSequentially("?");
		await expect(box).toHaveValue(
			new RegExp(`^Can you take this, \\[@${guest.name}\\]\\(mention:[^)]+\\) \\?$`),
		);

		// Escape closes the menu and leaves the text as typed.
		await box.pressSequentially(" Or @");
		await expect(menu.getByRole("option")).toHaveCount(2);
		for (const person of [guest, owner]) {
			await expect(menu.getByRole("option", { name: person.name, exact: true })).toBeVisible();
		}
		await box.press("Escape");
		await expect(menu).toBeHidden();
		await expect(box).toBeVisible();
		await box.press("Backspace");
		await box.press("Backspace");
		await box.press("Backspace");
		await box.press("Backspace");
		await page.getByRole("button", { name: "Comment", exact: true }).click();

		const posted = page.getByRole("article").filter({ hasText: "Can you take this" });
		await expect(posted.getByText(`@${guest.name}`, { exact: true })).toBeVisible();

		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox, 1 unread");
		await expect(guestPage.getByRole("listitem").filter({ hasText: title })).toContainText(
			`${owner.name} mentioned you: Can you take this, @${guest.name}`,
		);
	} finally {
		await guestContext.close();
	}
});
