import { expect, newBrowserContext, test } from "./fixtures";
import {
	createIssue,
	issueRow,
	joinByInvitation,
	startWorkspace,
	syncBadge,
	unique,
	waitForHydration,
} from "./helpers";

// Changing a name and a password on the account page. What the server refuses, and why, is in
// test/account-changes.test.ts; these show what people see of it, on each browser involved.

test("someone changes their name, and the team sees it as it happens", async ({
	page,
	browser,
}) => {
	const workspace = await startWorkspace(page);
	const { slug } = workspace;
	await createIssue(page, unique("Rotate the signing keys"));

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		const guest = await joinByInvitation(page, guestPage, workspace);

		await page.goto(`/${slug}/issue/ENG-1`);
		const box = page.getByRole("textbox", { name: "Comment", exact: true });
		await box.click();
		await box.pressSequentially("Over to you, @guest");
		await box.press("Enter");
		await page.getByRole("button", { name: "Comment", exact: true }).click();
		const posted = page.getByRole("article").filter({ hasText: "Over to you" });
		await expect(posted.getByText(`@${guest.name}`, { exact: true })).toBeVisible();

		await guestPage.goto(`/${slug}`);
		await guestPage.getByRole("button", { name: workspace.name }).first().click();
		await guestPage.getByRole("menuitem", { name: "Your account" }).click();
		await expect(guestPage.getByRole("heading", { name: "Your account" })).toBeVisible();

		const save = guestPage.getByRole("button", { name: "Save name" });
		const field = guestPage.getByLabel("Your name");
		await expect(field).toHaveValue(guest.name);
		await expect(save).toBeDisabled();

		const name = unique("Renamed");
		await field.fill(`  ${name}  `);
		await save.click();
		await expect(guestPage.getByText("Your name is changed.")).toBeVisible();
		await expect(field).toHaveValue(name);
		await expect(guestPage.getByRole("banner").getByText(name)).toBeVisible();
		await expect(save).toBeDisabled();

		// The owner, who never reloaded, sees it as it happens, in what was already written too.
		await expect(posted.getByText(`@${name}`, { exact: true })).toBeVisible();
		await expect(page.getByText(guest.name)).toHaveCount(0);

		await guestPage.reload();
		await expect(guestPage.getByLabel("Your name")).toHaveValue(name);
	} finally {
		await guestContext.close();
	}
});

test("someone changes their password, and only this browser stays signed in", async ({
	page,
	context,
	browser,
}) => {
	const { person, slug } = await startWorkspace(page);
	const before = unique("Before the password changed");
	await createIssue(page, before);
	// Reloaded, so nothing from making the workspace is still moving when the session ends.
	await page.reload();
	await expect(issueRow(page, before)).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	const elsewhereContext = await newBrowserContext(browser);
	try {
		const elsewhere = await elsewhereContext.newPage();
		const signIn = async (password: string) => {
			await elsewhere.goto("/login");
			await waitForHydration(elsewhere);
			await elsewhere.getByLabel("Email").fill(person.email);
			await elsewhere.getByLabel("Password").fill(password);
			await elsewhere.getByRole("button", { name: "Sign in", exact: true }).click();
		};
		await signIn(person.password);
		await expect(elsewhere).not.toHaveURL(/\/login/);
		await elsewhere.goto(`/${slug}/team/ENG`);
		await expect(issueRow(elsewhere, before)).toBeVisible();
		await expect(syncBadge(elsewhere)).toHaveText("Live");

		const account = await context.newPage();
		await account.goto("/settings/account");
		await account.getByRole("button", { name: "Change password" }).click();
		const newPassword = "a-new-correct-horse";
		const fill = async (current: string, again: string) => {
			await account.getByLabel("Current password").fill(current);
			await account.getByLabel("New password", { exact: true }).fill(newPassword);
			await account.getByLabel("New password again").fill(again);
			await account.getByRole("button", { name: "Save password" }).click();
		};

		// Neither of these changes anything.
		await fill(person.password, "something-else-again");
		await expect(account.getByRole("alert")).toHaveText("The new passwords do not match.");
		await fill("not-the-password", newPassword);
		await expect(account.getByRole("alert")).toHaveText("That password is not right.");
		await expect(syncBadge(elsewhere)).toHaveText("Live");

		await fill(person.password, newPassword);
		await expect(
			account.getByText("Your password is changed, and your other devices are signed out."),
		).toBeVisible();
		await expect(account.getByLabel("Current password")).toHaveCount(0);

		// The other device hears at once.
		await expect(elsewhere.getByRole("heading", { name: "Your session has ended" })).toBeVisible();

		// This browser holds the new session, so the tab that was left open carries on with it.
		await expect(syncBadge(page)).toHaveText("Live");
		const after = unique("After the password changed");
		await createIssue(page, after);
		await expect(issueRow(page, after)).toBeVisible();

		// The old password opens nothing now, and the new one reaches what was written since.
		await signIn(person.password);
		await expect(elsewhere.getByRole("alert")).toBeVisible();
		await expect(elsewhere).toHaveURL(/\/login/);
		await signIn(newPassword);
		await expect(elsewhere).not.toHaveURL(/\/login/);
		await elsewhere.goto(`/${slug}/team/ENG`);
		await expect(issueRow(elsewhere, after)).toBeVisible();
	} finally {
		await elsewhereContext.close();
	}
});
