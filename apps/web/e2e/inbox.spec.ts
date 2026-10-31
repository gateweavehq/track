import type { Page } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import { createIssue, joinByInvitation, startWorkspace, unique } from "./helpers";

/** The sidebar's link to the inbox. Its name carries the unread count, when there is one. */
function inboxLink(page: Page) {
	return page.getByRole("link", { name: /^Inbox(, \d+ unread)?$/ }).first();
}

/** A tab of the inbox page. */
function inboxTab(page: Page, name: "Inbox" | "Snoozed" | "Archived") {
	return page.getByRole("navigation", { name: "Inbox" }).getByRole("link", { name });
}

function inboxRow(page: Page, title: string) {
	return page.getByRole("listitem").filter({ hasText: title });
}

async function comment(page: Page, body: string) {
	await page.getByRole("textbox", { name: "Comment", exact: true }).fill(body);
	await page.getByRole("button", { name: "Comment", exact: true }).click();
}

test("subscribers hear of comments, assignments and status changes in their inbox", async ({
	page,
	browser,
}) => {
	const workspace = await startWorkspace(page);
	const { slug, person: owner } = workspace;
	const title = unique("Audit log for admin actions");
	await createIssue(page, title);

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		const guest = await joinByInvitation(page, guestPage, workspace);

		// The owner filed the issue, so they are subscribed: the guest's comment reaches them live.
		await page.goto(`/${slug}/inbox`);
		await expect(page.getByText("You're all caught up")).toBeVisible();
		await guestPage.goto(`/${slug}/issue/ENG-1`);
		await comment(guestPage, "Which events should it keep?");
		await expect(inboxLink(page)).toHaveAccessibleName("Inbox, 1 unread");
		const row = inboxRow(page, title);
		await expect(row).toContainText(`${guest.name} commented: Which events should it keep?`);

		// Opening the issue reads its news.
		await row.getByRole("link").click();
		await expect(page).toHaveURL(`/${slug}/issue/ENG-1`);
		await expect(inboxLink(page)).toHaveAccessibleName("Inbox");

		// The assignee hears of the assignment. (Had they the issue open, it would be read at once.)
		await guestPage.goto(`/${slug}/inbox`);
		const properties = page.getByRole("complementary", { name: "Properties" });
		await properties.getByRole("button", { name: "Unassigned" }).click();
		await page.getByRole("option", { name: guest.name }).click();
		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox, 1 unread");
		const guestRow = inboxRow(guestPage, title);
		await expect(guestRow).toContainText(`${owner.name} assigned you`);

		await guestRow.hover();
		await guestRow.getByRole("button", { name: "Mark ENG-1 read" }).click();
		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox");
		await guestRow.getByRole("button", { name: "Mark ENG-1 unread" }).click();
		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox, 1 unread");

		// Archived, the item waits on its tab until news on the issue brings it back.
		await guestRow.getByRole("button", { name: "Archive ENG-1" }).click();
		await expect(guestPage.getByText("You're all caught up")).toBeVisible();
		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox");
		await inboxTab(guestPage, "Archived").click();
		await expect(inboxRow(guestPage, title)).toBeVisible();

		await properties.getByRole("button", { name: "Backlog" }).click();
		await page.getByRole("option", { name: "In Progress" }).click();
		await expect(guestPage.getByText("Nothing archived")).toBeVisible();
		await inboxTab(guestPage, "Inbox").click();
		await expect(guestRow).toContainText(`${owner.name} moved it from Backlog to In Progress`);
		await expect(inboxLink(guestPage)).toHaveAccessibleName("Inbox, 1 unread");

		// Snoozed, it waits on its own tab.
		await guestRow.hover();
		await guestRow.getByRole("button", { name: "Snooze ENG-1" }).click();
		await guestPage.getByRole("menuitem", { name: /^Tomorrow/ }).click();
		await expect(guestPage.getByText("You're all caught up")).toBeVisible();
		await inboxTab(guestPage, "Snoozed").click();
		await expect(inboxRow(guestPage, title)).toContainText("Until");

		// Unsubscribing sticks.
		await page.getByRole("button", { name: "Unsubscribe" }).click();
		await expect(page.getByRole("button", { name: "Subscribe" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await page.reload();
		await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
	} finally {
		await guestContext.close();
	}
});
