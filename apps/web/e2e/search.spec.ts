import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, unique } from "./helpers";

test("the palette finds an issue by a word in its description and opens it", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const title = unique("Checkout flow");
	const word = `zeppelin${Math.random().toString(36).slice(2, 8)}`;
	await createIssue(page, title, `Customers report that the ${word} banner overlaps the total.`);

	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "Command palette" });
	await palette.getByPlaceholder("Search issues or type a command…").fill(word.slice(0, -2));

	const result = palette.getByRole("option", { name: new RegExp(title) });
	await expect(result).toBeVisible();
	await expect(result).toContainText(`the ${word} banner overlaps the total.`);

	await result.click();
	await expect(page).toHaveURL(`/${slug}/issue/ENG-1`);
	await expect(page.getByText(title).first()).toBeVisible();
});
