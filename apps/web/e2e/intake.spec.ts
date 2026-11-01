import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("a request waits in the team's intake, out of lists, until it is accepted or declined", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const planned = unique("Write the onboarding guide");
	const wanted = unique("Export the board to PDF");
	const unwanted = unique("Rewrite it in another language");
	await createIssue(page, planned);

	// Requests are filed from the team's intake page, and the list leaves them out.
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("link", { name: "Engineering intake, 0 requests" }).click();
	await expect(page.getByRole("heading", { name: "No requests waiting" })).toBeVisible();
	for (const title of [wanted, unwanted]) {
		await page.getByRole("button", { name: "New request" }).first().click();
		await page.getByLabel("Title").fill(title);
		await page.getByRole("button", { name: "File request" }).click();
		await expect(page.getByRole("dialog")).toBeHidden();
	}
	const intake = page.getByRole("list", { name: "Engineering intake" });
	await expect(intake.getByRole("listitem")).toHaveCount(2);
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, planned)).toBeVisible();
	await expect(issueRow(page, wanted)).toBeHidden();

	// Accepted from its page, a request joins the list.
	await page.goto(`/${slug}/issue/ENG-2`);
	const notice = page.getByRole("status").filter({ hasText: /^A request in/ });
	await expect(notice).toBeVisible();
	await notice.getByRole("button", { name: "Accept" }).click();
	await expect(notice).toBeHidden();
	await expect(page.getByText("accepted the request")).toBeVisible();

	// Declined from the intake page, with a reply, it is canceled.
	await page.goto(`/${slug}/team/ENG/intake`);
	await intake.getByRole("button", { name: "Decline ENG-3" }).click();
	await page.getByLabel("Reply").fill("Not something we plan to do.");
	await page.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
	await expect(page.getByRole("heading", { name: "No requests waiting" })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, wanted)).toBeVisible();
	await page.goto(`/${slug}/issue/ENG-3`);
	await expect(page.getByText("declined the request")).toBeVisible();
	await expect(page.getByText("Not something we plan to do.")).toBeVisible();
	const properties = page.getByRole("complementary", { name: "Properties" });
	await expect(properties.getByRole("button", { name: /^Canceled/ })).toBeVisible();
});

test("an admin turns the team's request form on, shares its link, and turns it off", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/team/ENG/intake`);
	await page.getByRole("button", { name: "Request form" }).click();
	const dialog = page.getByRole("dialog", { name: "Request form for Engineering" });
	await expect(dialog.getByText("The form is off.")).toBeVisible();
	// The test server has no Turnstile keys, so the dialog says the form cannot take requests.
	await expect(dialog.getByRole("alert")).toContainText("TURNSTILE_SITE_KEY");

	await dialog.getByRole("button", { name: "Turn on" }).click();
	const link = dialog.getByLabel("Form link");
	await expect(link).toHaveValue(/\/request\/[\w-]+\/[0-9a-f]{32}$/);
	const first = await link.inputValue();
	await dialog.getByRole("button", { name: "New link" }).click();
	await expect(link).not.toHaveValue(first);
	await expect(syncBadge(page)).toHaveText("Live");

	// Without Turnstile the link leads to a page that says the form is not open.
	const response = await page.request.get(await link.inputValue());
	expect(response.status()).toBe(404);

	await dialog.getByRole("button", { name: "Turn off" }).click();
	await expect(dialog.getByText("The form is off.")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Request form" })).toBeVisible();
});
