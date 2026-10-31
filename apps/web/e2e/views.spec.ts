import type { Page } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import {
	createIssue,
	issueRow,
	joinByInvitation,
	startWorkspace,
	syncBadge,
	unique,
} from "./helpers";

/** Ticks values of one filter in the filter menu, then closes the menu. */
async function filterBy(page: Page, filter: string, ...values: string[]) {
	await page.getByRole("button", { name: "Filter", exact: true }).click();
	await page.getByRole("option", { name: filter }).click();
	for (const value of values) await page.getByRole("option", { name: value }).click();
	await page.keyboard.press("Escape");
}

/** Names the view in the open "Save view" or "Save as a new view" dialog and saves it. */
async function nameView(page: Page, name: string, { personal = false } = {}) {
	const dialog = page.getByRole("dialog", { name: /^Save/ });
	await dialog.getByLabel("Name").fill(name);
	if (personal) await dialog.getByLabel("Only for me").check();
	await dialog.getByRole("button", { name: "Save view" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

function viewsNav(page: Page) {
	return page.getByRole("navigation", { name: "Views" });
}

/** Two issues in ENG, the first of them urgent. */
async function urgentAndNot(page: Page, slug: string) {
	const outage = unique("Fix the outage");
	const docs = unique("Tidy the docs");
	await createIssue(page, outage);
	await createIssue(page, docs);
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^No priority/ }).click();
	await page.getByRole("option", { name: "Urgent" }).click();
	await expect(syncBadge(page)).toHaveText("Live");
	return { outage, docs };
}

test("a saved view keeps filters and a layout, and changes are saved into it or as a new one", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const { outage, docs } = await urgentAndNot(page, slug);

	// Saving is offered once there are filters.
	await page.goto(`/${slug}/team/ENG`);
	await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);
	await filterBy(page, "Priority", "Urgent");
	await page.getByRole("button", { name: "Save view" }).click();
	await nameView(page, "Urgent");
	await expect(page).toHaveURL(new RegExp(`/${slug}/view/[0-9a-f-]+$`));
	await expect(issueRow(page, outage)).toBeVisible();
	await expect(issueRow(page, docs)).toBeHidden();
	await expect(viewsNav(page).getByRole("link", { name: "Urgent" })).toBeVisible();

	// A view shows issues from the whole workspace, so it keeps the team it was saved from.
	const chips = page.getByRole("group", { name: "Filters in force" });
	await expect(chips.getByTitle("Team: Engineering")).toBeVisible();

	// A change shows as unsaved until it is saved; then it stays after a reload.
	await page.getByRole("button", { name: "Board", exact: true }).click();
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Unsaved changes")).toBeHidden();
	await page.reload();
	await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Reset goes back to the saved filters.
	await page.getByRole("button", { name: "Remove the priority filter" }).click();
	await expect(issueRow(page, docs)).toBeVisible();
	await page.getByRole("button", { name: "Discard the changes" }).click();
	await expect(issueRow(page, docs)).toBeHidden();
	await expect(chips.getByTitle("Priority: Urgent")).toBeVisible();

	// "Save as new" leaves the view as it was.
	await page.getByRole("button", { name: "Remove the priority filter" }).click();
	await page.getByRole("button", { name: "Save as new" }).click();
	await nameView(page, "All of ENG");
	await expect(issueRow(page, docs)).toBeVisible();
	await viewsNav(page).getByRole("link", { name: "Urgent" }).click();
	await expect(page.getByRole("heading", { name: "Urgent", level: 1 })).toBeVisible();
	await expect(issueRow(page, docs)).toBeHidden();

	// Rename it, then delete it.
	await page.getByRole("button", { name: "Shared view options" }).click();
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const rename = page.getByRole("dialog", { name: "Rename view" });
	await rename.getByLabel("Name").fill("Urgent in ENG");
	await rename.getByRole("button", { name: "Rename" }).click();
	await expect(page.getByRole("heading", { name: "Urgent in ENG", level: 1 })).toBeVisible();
	await expect(viewsNav(page).getByRole("link", { name: "Urgent in ENG" })).toBeVisible();

	await page.getByRole("button", { name: "Shared view options" }).click();
	await page.getByRole("menuitem", { name: "Delete view" }).click();
	await page.getByRole("button", { name: "Delete view" }).click();
	await expect(page).not.toHaveURL(/\/view\//);
	await expect(viewsNav(page).getByRole("link", { name: "Urgent in ENG" })).toHaveCount(0);
	await expect(viewsNav(page).getByRole("link", { name: "All of ENG" })).toBeVisible();
});

test("a personal view is its owner's, and sharing it shows it to everyone", async ({
	page,
	browser,
}) => {
	const { slug, name } = await startWorkspace(page);
	const { outage, docs } = await urgentAndNot(page, slug);

	await page.goto(`/${slug}/team/ENG`);
	await filterBy(page, "Priority", "Urgent");
	await page.getByRole("button", { name: "Save view" }).click();
	await nameView(page, "My urgent", { personal: true });
	const personalUrl = page.url();
	await expect(viewsNav(page).getByRole("link", { name: "My urgent" })).toBeVisible();

	await page.goto(`/${slug}/team/ENG`);
	await filterBy(page, "Priority", "No priority");
	await page.getByRole("button", { name: "Save view" }).click();
	await nameView(page, "Triage");

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		await joinByInvitation(page, guestPage, { slug, name });

		// The guest sees the shared view, but not the personal one, even by its link.
		const guestViews = viewsNav(guestPage);
		await expect(guestViews.getByRole("link", { name: "Triage" })).toBeVisible();
		await expect(guestViews.getByRole("link", { name: "My urgent" })).toHaveCount(0);
		await guestPage.goto(personalUrl);
		await expect(guestPage.getByRole("heading", { name: "View not found" })).toBeVisible();

		// A member who did not save a shared view may look at it differently and keep that as a
		// view of their own, but not change it for everyone.
		await guestViews.getByRole("link", { name: "Triage" }).click();
		await expect(issueRow(guestPage, docs)).toBeVisible();
		await expect(guestPage.getByRole("button", { name: "Shared view options" })).toHaveCount(0);
		await guestPage.getByRole("button", { name: "Board", exact: true }).click();
		await expect(guestPage.getByText("Unsaved changes")).toBeVisible();
		await expect(guestPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
		await expect(guestPage.getByRole("button", { name: "Save as new" })).toBeVisible();

		// Once shared, the guest has it too, live.
		await page.goto(personalUrl);
		await page.getByRole("button", { name: "Personal view options" }).click();
		await page.getByRole("menuitem", { name: "Share with the workspace" }).click();
		await expect(page.getByRole("button", { name: "Shared view options" })).toBeVisible();
		await guestViews.getByRole("link", { name: "My urgent" }).click();
		await expect(issueRow(guestPage, outage)).toBeVisible();
		await expect(issueRow(guestPage, docs)).toBeHidden();
	} finally {
		await guestContext.close();
	}
});

/** Picks a radio option of the Display menu, such as a way to group or order by. */
async function displayOption(page: Page, name: string) {
	await page.getByRole("button", { name: /^Display options/ }).click();
	// Group by and Order by both offer Priority; the first is the grouping.
	await page.getByRole("menuitemradio", { name, exact: true }).first().click();
	await page.keyboard.press("Escape");
}

test("a shared view keeps how it groups, orders and lays out issues, for everyone", async ({
	page,
	browser,
}) => {
	const { slug, name } = await startWorkspace(page);
	const { outage, docs } = await urgentAndNot(page, slug);
	await page.goto(`/${slug}/team/ENG`);
	const extra = unique("Archive the logs");
	await createIssue(page, extra);

	/** Whether the first issue's row is above the second's. */
	async function above(on: Page, first: string, second: string) {
		const [a, b] = await Promise.all([
			issueRow(on, first).boundingBox(),
			issueRow(on, second).boundingBox(),
		]);
		return a !== null && b !== null && a.y < b.y;
	}
	const group = (on: Page, title: string) =>
		on.getByRole("heading", { level: 2, name: new RegExp(`^${title}`) });

	// By default the list groups by status, in manual order: the older issue comes first.
	await expect(group(page, "Backlog")).toBeVisible();
	await expect.poll(() => above(page, docs, extra)).toBe(true);

	// Group by priority and order by when issues were made, newest first. These are changes to the
	// page's link, not yet to any view.
	await displayOption(page, "Priority");
	await displayOption(page, "Created");
	await expect(group(page, "Urgent")).toBeVisible();
	await expect(group(page, "No priority")).toBeVisible();
	await expect(group(page, "Backlog")).toHaveCount(0);
	await expect(issueRow(page, outage)).toBeVisible();
	await expect.poll(() => above(page, extra, docs)).toBe(true);
	await expect(page).toHaveURL(/group=priority/);

	// Display options alone are enough to offer saving a view.
	await page.getByRole("button", { name: "Save view" }).click();
	await nameView(page, "By priority");
	const viewUrl = page.url();
	await expect(group(page, "Urgent")).toBeVisible();
	await expect.poll(() => above(page, extra, docs)).toBe(true);
	await expect(page.getByText("Unsaved changes")).toBeHidden();

	// Changing them shows as unsaved, like filters, and goes back with Reset.
	await displayOption(page, "No grouping");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await expect(group(page, "Urgent")).toHaveCount(0);
	await page.getByRole("button", { name: "Discard the changes" }).click();
	await expect(page.getByText("Unsaved changes")).toBeHidden();
	await expect(group(page, "Urgent")).toBeVisible();

	// The table's columns and sort are kept in the view too.
	await page.getByRole("button", { name: "Table", exact: true }).click();
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await page.getByRole("button", { name: "Columns" }).click();
	await page.getByRole("menuitemcheckbox", { name: "Project" }).click();
	await page.keyboard.press("Escape");
	await page.getByRole("columnheader", { name: "Title" }).getByRole("button").click();
	await expect(page.getByRole("columnheader", { name: "Project" })).toBeHidden();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Unsaved changes")).toBeHidden();

	// Someone else opening the view sees the same table: no Project column, sorted by title.
	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		await joinByInvitation(page, guestPage, { slug, name });
		await guestPage.goto(viewUrl);
		await expect(guestPage.getByRole("heading", { name: "By priority", level: 1 })).toBeVisible();
		await expect(guestPage.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
			"aria-sort",
			"ascending",
		);
		await expect(guestPage.getByRole("columnheader", { name: "Status" })).toBeVisible();
		await expect(guestPage.getByRole("columnheader", { name: "Project" })).toBeHidden();
		await expect(guestPage.getByText("Unsaved changes")).toBeHidden();

		// And in the list, the same grouping and order.
		await guestPage.getByRole("button", { name: "List", exact: true }).click();
		await expect(group(guestPage, "Urgent")).toBeVisible();
		await expect(group(guestPage, "No priority")).toBeVisible();
		await expect.poll(() => above(guestPage, extra, docs)).toBe(true);
	} finally {
		await guestContext.close();
	}
});
