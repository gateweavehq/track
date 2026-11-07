import { expect, newBrowserContext, test } from "./fixtures";
import { createIssue, joinByInvitation, startWorkspace, unique } from "./helpers";

test("someone deletes their account, and their name goes from what the team sees", async ({
	page,
	browser,
}) => {
	const workspace = await startWorkspace(page);
	const { slug } = workspace;
	const title = unique("Rotate the signing keys");
	await createIssue(page, title);

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		const guest = await joinByInvitation(page, guestPage, workspace);

		// The guest's name, as a mention that keeps it in the Markdown.
		await page.goto(`/${slug}/issue/ENG-1`);
		const box = page.getByRole("textbox", { name: "Comment", exact: true });
		await box.click();
		await box.pressSequentially("Over to you, @guest");
		await box.press("Enter");
		await page.getByRole("button", { name: "Comment", exact: true }).click();
		const posted = page.getByRole("article").filter({ hasText: "Over to you" });
		await expect(posted.getByText(`@${guest.name}`, { exact: true })).toBeVisible();

		// A wrong password leaves everything as it was.
		await guestPage.goto(`/${slug}`);
		await guestPage.getByRole("button", { name: workspace.name }).first().click();
		await guestPage.getByRole("menuitem", { name: "Your account" }).click();
		await expect(guestPage.getByRole("heading", { name: "Your account" })).toBeVisible();
		await guestPage.getByRole("button", { name: "Delete account" }).click();
		await guestPage.getByLabel("Your password").fill("not-the-password");
		await guestPage.getByRole("button", { name: "Delete my account" }).click();
		await expect(guestPage.getByRole("alert")).toHaveText("That password is not right.");

		await guestPage.getByLabel("Your password").fill(guest.password);
		await guestPage.getByRole("button", { name: "Delete my account" }).click();
		await expect(guestPage.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
		expect(await guestPage.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);

		// The owner, who never reloaded, sees it as it happens.
		await expect(posted.getByText("@Deleted member", { exact: true })).toBeVisible();
		await expect(page.getByText(guest.name)).toHaveCount(0);

		// And the account is gone: the page sends them to sign in, which refuses the old password.
		await guestPage.getByRole("link", { name: "Back to sign-in" }).click();
		await expect(guestPage).toHaveURL(/\/login/);
		await guestPage.getByLabel("Email").fill(guest.email);
		await guestPage.getByLabel("Password").fill(guest.password);
		await guestPage.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(guestPage.getByRole("alert")).toBeVisible();
	} finally {
		await guestContext.close();
	}
});

test("the only owner of a workspace is told which one stands in the way", async ({ page }) => {
	const workspace = await startWorkspace(page);

	await page.goto("/account");
	await page.getByRole("button", { name: "Delete account" }).click();
	await page.getByLabel("Your password").fill(workspace.person.password);
	await page.getByRole("button", { name: "Delete my account" }).click();

	await expect(page.getByRole("alert")).toContainText(
		`You are the only owner of ${workspace.name}.`,
	);
	await page.getByRole("link", { name: "Workspaces" }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
});
