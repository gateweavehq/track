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
