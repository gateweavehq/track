import { expect, test } from "./fixtures";
import { startWorkspace, syncBadge } from "./helpers";

// A spreadsheet from another tracker: its own column names, a parent named by key, and dates.
const CSV = [
	"Key,Summary,State,Priority,Tags,Parent,Created",
	"OLD-1,Plan the launch,In Progress,High,Launch,,2024-03-01T10:00:00Z",
	'OLD-2,Write the announcement,To Do,Low,"Launch, Docs",OLD-1,2024-03-02T10:00:00Z',
	"",
].join("\r\n");

test("an admin imports issues from a CSV file, and importing it again skips them", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/import`);
	const chooseFile = async () => {
		await page.locator('input[type="file"]').setInputFiles({
			name: "old-tracker.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(CSV),
		});
	};

	await chooseFile();
	await expect(page.getByText("From CSV: 2 issues.")).toBeVisible();
	await expect(page.getByText("New labels: Launch, Docs.")).toBeVisible();
	await expect(page.getByLabel("Into team")).toHaveValue(/.+/);
	await page.getByRole("button", { name: "Import 2 issues" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 2 issues.");
	await expect(syncBadge(page)).toHaveText("Live");

	// Oldest first, so the numbers follow the old tracker's, with the parent and dates it had.
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Write the announcement");
	await expect(page.getByRole("link", { name: /Sub-issue of ENG-1/ })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Properties" }).getByRole("button", { name: /^Todo/ }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Activity" }).locator("time")).toHaveAttribute(
		"datetime",
		"2024-03-02T10:00:00.000Z",
	);
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Plan the launch");
	await expect(
		page.getByRole("region", { name: "Sub-issues" }).getByRole("link", {
			name: "Write the announcement",
		}),
	).toBeVisible();

	// The same file again brings in nothing.
	await page.goto(`/${slug}/settings/import`);
	await chooseFile();
	await expect(
		page.getByText("Everything here was imported before. There is nothing new to bring in."),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("a CSV file without titles is explained, not imported", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/import`);
	await page.locator('input[type="file"]').setInputFiles({
		name: "keys.csv",
		mimeType: "text/csv",
		buffer: Buffer.from("Key,Status\nOLD-1,Done\n"),
	});
	await expect(page.getByRole("alert")).toHaveText(
		'The file needs a column of titles, named "Title", "Summary" or "Name".',
	);
});
