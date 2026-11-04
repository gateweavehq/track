import { expect, newBrowserContext, test } from "./fixtures";
import {
	createFirstTeam,
	createIssue,
	createWorkspace,
	issueRow,
	joinByInvitation,
	signUp,
	startWorkspace,
	syncBadge,
	teamUrl,
	unique,
} from "./helpers";

test("sign up, create a workspace and a team, and file the first issue", async ({ page }) => {
	await signUp(page);
	const { slug } = await createWorkspace(page);
	await createFirstTeam(page, slug);

	const title = unique("First issue");
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
});

test("a new workspace can start with a guided team and its issues", async ({ page }) => {
	await signUp(page);
	await createWorkspace(page, { guided: true });
	await expect(issueRow(page, "Welcome to Track")).toBeVisible();
	await expect(issueRow(page, "Press C to create an issue")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
});

test("an empty workspace offers the guided team on its first-team page", async ({ page }) => {
	await signUp(page);
	const { slug } = await createWorkspace(page);
	await page.getByRole("button", { name: "Start with a guided team" }).click();
	await expect(page).toHaveURL(teamUrl(slug));
	await expect(issueRow(page, "Welcome to Track")).toBeVisible();
});

test("the new-issue dialog stays within a short window, its button in reach", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.setViewportSize({ width: 1280, height: 520 });
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "New issue" }).first().click();
	const dialog = page.getByRole("dialog", { name: "New issue" });
	const title = unique("Long description");
	await dialog.getByLabel("Title").fill(title);
	await dialog
		.getByLabel("Description")
		.fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n"));

	// Opened a fifth of the way down, the dialog ran past the bottom of the window, and so did its
	// button, whatever it scrolled.
	const box = await dialog.boundingBox();
	expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(520);
	const create = dialog.getByRole("button", { name: "Create issue" });
	await create.scrollIntoViewIfNeeded();
	await expect(create).toBeInViewport({ ratio: 1 });
	await create.click();
	await expect(dialog).toBeHidden();
	await expect(issueRow(page, title)).toBeVisible();
});

test("an edit in one tab appears in another without a reload", async ({ page, context }) => {
	const { slug } = await startWorkspace(page);
	const other = await context.newPage();
	await other.goto(`/${slug}/team/ENG`);
	await expect(syncBadge(other)).toHaveText("Live");

	const fromFirst = unique("From the first tab");
	await createIssue(page, fromFirst);
	await expect(issueRow(other, fromFirst)).toBeVisible();

	const fromSecond = unique("From the second tab");
	await createIssue(other, fromSecond);
	await expect(issueRow(page, fromSecond)).toBeVisible();
});

test("leaving a workspace goes back to the person's workspaces, and takes their other tab along", async ({
	page,
	browser,
}) => {
	const workspace = await startWorkspace(page);
	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		const guest = await joinByInvitation(page, guestPage, workspace);
		const otherTab = await guestContext.newPage();
		await otherTab.goto(`/${workspace.slug}/team/ENG`);
		await expect(syncBadge(otherTab)).toHaveText("Live");

		await guestPage.goto(`/${workspace.slug}/settings/members`);
		await guestPage.getByRole("button", { name: `More for ${guest.name}` }).click();
		await guestPage.getByRole("menuitem", { name: `Leave ${workspace.name}` }).click();
		let reloads = 0;
		guestPage.on("load", () => {
			reloads += 1;
		});
		await guestPage.getByRole("button", { name: "Leave", exact: true }).click();

		await expect(guestPage.getByText(`You left ${workspace.name}`)).toBeVisible();
		await expect(guestPage.getByRole("heading", { name: "Workspaces" })).toBeVisible();
		await expect(
			otherTab.getByRole("heading", { name: /no longer have access|Workspace not found/ }),
		).toBeVisible();
		// The other tab deletes this device's copy as soon as it hears, which must not reload this one
		// on its way out and take the message with it. A reload would come a moment after that delete,
		// as the tab asks the server first, so nothing shows it has not happened but waiting.
		await guestPage.waitForTimeout(1_500);
		expect(reloads).toBe(0);
	} finally {
		await guestContext.close();
	}
});

test("a second person who joined by invitation link sees edits live", async ({ page, browser }) => {
	const workspace = await startWorkspace(page);
	const { slug } = workspace;

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		await joinByInvitation(page, guestPage, workspace);
		await expect(guestPage).toHaveURL(new RegExp(`/${slug}(/team/ENG)?$`));

		const fromOwner = unique("From the owner");
		await page.goto(`/${slug}/team/ENG`);
		await createIssue(page, fromOwner);
		await expect(issueRow(guestPage, fromOwner)).toBeVisible();

		await guestPage.goto(`/${slug}/team/ENG`);
		const fromGuest = unique("From the guest");
		await createIssue(guestPage, fromGuest);
		await expect(issueRow(page, fromGuest)).toBeVisible();
	} finally {
		await guestContext.close();
	}
});
