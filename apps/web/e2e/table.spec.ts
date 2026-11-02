import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

function rowOf(page: Page, title: string) {
	return page.getByRole("row").filter({ hasText: title });
}

test("the table edits issues in place, sorts them and remembers its columns", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const first = unique("Write the docs");
	const second = unique("Fix the login");
	const third = unique("Plan the launch");
	// Newest last in manual order: first, second, third.
	await createIssue(page, first);
	await createIssue(page, second);
	await createIssue(page, third);

	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Table" }).click();
	await expect(page).toHaveURL(/view=table/);
	await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Due date" })).toBeVisible();

	// The view survives a reload, because it is in the URL.
	await page.reload();
	await expect(page).toHaveURL(/view=table/);
	await expect(page.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
	await expect(rowOf(page, first)).toBeVisible();
	await expect(page.getByRole("row")).toHaveCount(4);

	// Status and priority change from the row.
	await rowOf(page, first)
		.getByRole("button", { name: /^Status: / })
		.click();
	await page.getByRole("option", { name: "In Progress" }).click();
	await expect(
		rowOf(page, first).getByRole("button", { name: "Status: In Progress" }),
	).toBeVisible();
	await rowOf(page, first)
		.getByRole("button", { name: /^Priority: / })
		.click();
	await page.getByRole("option", { name: "High" }).click();
	await expect(rowOf(page, first).getByRole("button", { name: "Priority: High" })).toBeVisible();
	await rowOf(page, second)
		.getByRole("button", { name: /^Priority: / })
		.click();
	await page.getByRole("option", { name: "Urgent" }).click();
	await expect(rowOf(page, second).getByRole("button", { name: "Priority: Urgent" })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The issue page shows the same.
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByText(first).first()).toBeVisible();
	await expect(page.getByRole("button", { name: "In Progress" })).toBeVisible();
	await expect(page.getByRole("button", { name: "High" })).toBeVisible();

	// Back in the table (the view is remembered), the rows follow the manual order.
	await page.goto(`/${slug}/team/ENG`);
	const rows = page.getByRole("row");
	await expect(rows.nth(1)).toContainText(first);
	await expect(rows.nth(3)).toContainText(third);

	// Sorting by priority puts the most urgent first, and empty priorities last either way.
	const priority = page.getByRole("columnheader", { name: "Priority" });
	await priority.getByRole("button").click();
	await expect(priority).toHaveAttribute("aria-sort", "ascending");
	await expect(rows.nth(1)).toContainText(second);
	await expect(rows.nth(2)).toContainText(first);
	await expect(rows.nth(3)).toContainText(third);
	await priority.getByRole("button").click();
	await expect(priority).toHaveAttribute("aria-sort", "descending");
	await expect(rows.nth(1)).toContainText(first);
	await expect(rows.nth(2)).toContainText(second);
	await expect(rows.nth(3)).toContainText(third);

	// Sorting by another column moves the direction there, and a button brings back manual order.
	await page.getByRole("columnheader", { name: "Title" }).getByRole("button").click();
	await expect(priority).not.toHaveAttribute("aria-sort", /.+/);
	await page.getByRole("button", { name: "Manual order" }).click();
	await expect(page.getByRole("button", { name: "Manual order" })).toBeHidden();
	await expect(rows.nth(1)).toContainText(first);
	await expect(rows.nth(2)).toContainText(second);

	// A hidden column stays hidden after a reload.
	await page.getByRole("button", { name: "Columns" }).click();
	await page.getByRole("menuitemcheckbox", { name: "Project" }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("columnheader", { name: "Project" })).toBeHidden();
	await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
	await page.reload();
	await expect(rowOf(page, first)).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Project" })).toBeHidden();
	await page.getByRole("button", { name: "Columns" }).click();
	await expect(page.getByRole("menuitemcheckbox", { name: "Project" })).not.toBeChecked();
	await expect(page.getByRole("menuitemcheckbox", { name: "ID" })).toHaveCount(0);
});

test("on a phone the table scrolls inside itself, not the page", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Narrow screens"));
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto(`/${slug}/team/ENG`);
	// On a phone the layouts are in a menu, so the header fits the screen.
	await page.getByRole("button", { name: "View: List" }).click();
	await page.getByRole("menuitemradio", { name: "Table" }).click();
	await expect(page).toHaveURL(/view=table/);
	await expect(page.getByRole("columnheader", { name: "Updated" })).toBeAttached();
	// The page is its own scroll container, so it is that, not the document, that must not overflow.
	const overflow = await page.evaluate(() => {
		const scrolled = (element: Element | null | undefined) =>
			element ? element.scrollWidth - element.clientWidth : 0;
		return {
			page: scrolled(document.querySelector("header + *")?.parentElement),
			table: scrolled(document.querySelector("table")?.parentElement),
		};
	});
	expect(overflow.page).toBeLessThanOrEqual(0);
	expect(overflow.table).toBeGreaterThan(0);
});

test("a long table renders the rows near the screen, and scrolls to the end", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	// A CSV import is the quick way to many issues.
	const titles = Array.from(
		{ length: 150 },
		(_, index) => `Bulk issue ${String(index + 1).padStart(3, "0")}`,
	);
	await page.goto(`/${slug}/settings/import`);
	await page.getByRole("button", { name: "File", exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "bulk.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(["Title", ...titles, ""].join("\r\n")),
	});
	await page.getByRole("button", { name: "Import 150 issues" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 150 issues.");

	await page.goto(`/${slug}/team/ENG?view=table`);
	const table = page.getByRole("table");
	await expect(table).toHaveAttribute("aria-rowcount", "151");
	await expect(rowOf(page, titles[0] ?? "")).toBeVisible();
	const rendered = await page.getByRole("row").count();
	expect(rendered).toBeGreaterThan(10);
	expect(rendered).toBeLessThan(100);

	// The last row is reached by scrolling, and announces its place among all of them.
	await page.mouse.move(400, 400);
	await page.mouse.wheel(0, 150 * 40);
	const last = rowOf(page, titles[149] ?? "");
	await expect(last).toBeVisible();
	await expect(last).toHaveAttribute("aria-rowindex", "151");
	await expect(rowOf(page, titles[0] ?? "")).toHaveCount(0);
});

test("rows are measured, so the keyboard reaches every row at a larger font size", async ({
	page,
}) => {
	// A reader's larger default font: rows are 2.5rem, 50 pixels here rather than 40.
	await page.addInitScript(() => {
		document.addEventListener("DOMContentLoaded", () => {
			const style = document.createElement("style");
			style.textContent = "html { font-size: 20px !important; }";
			document.head.append(style);
		});
	});
	const { slug } = await startWorkspace(page);
	const titles = Array.from(
		{ length: 150 },
		(_, index) => `Large issue ${String(index + 1).padStart(3, "0")}`,
	);
	await page.goto(`/${slug}/settings/import`);
	await page.getByRole("button", { name: "File", exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "large.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(["Title", ...titles, ""].join("\r\n")),
	});
	await page.getByRole("button", { name: "Import 150 issues" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 150 issues.");
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/team/ENG?view=table`);
	const first = titles[0] as string;
	const last = titles[149] as string;
	await expect(rowOf(page, first)).toBeVisible();
	expect((await rowOf(page, first).boundingBox())?.height).toBe(50);

	/** Expects the issue's row to have focus, on screen and under nothing: no header, no bar. */
	async function expectFocused(title: string) {
		const row = rowOf(page, title);
		await expect(row.getByRole("link", { name: title })).toBeFocused();
		await expect(row).toBeInViewport();
		// The row is wider than the screen, so its centre is taken across the part on screen.
		const uncovered = await row.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const right = Math.min(box.right, window.innerWidth);
			const hit = document.elementFromPoint((box.left + right) / 2, box.top + box.height / 2);
			return hit !== null && element.contains(hit);
		});
		expect(uncovered, `${title} is not covered`).toBe(true);
	}

	// Down past rows that were not rendered, then back up to the top.
	await rowOf(page, first).getByRole("link", { name: first }).focus();
	await press(page, "j", 100);
	await expectFocused(titles[100] as string);
	await expect(rowOf(page, first)).toHaveCount(0);
	// Screen readers still hear each row's place among all of them, the header row first.
	await expect(page.getByRole("table")).toHaveAttribute("aria-rowcount", "151");
	await expect(rowOf(page, titles[100] as string)).toHaveAttribute("aria-rowindex", "102");
	await press(page, "k", 60);
	await expectFocused(titles[40] as string);
	await press(page, "j", titles.length);
	await expectFocused(last);
	await expect(rowOf(page, last)).toHaveAttribute("aria-rowindex", "151");
	await press(page, "k", titles.length - 1);
	await expectFocused(first);
	await expect(rowOf(page, first)).toHaveAttribute("aria-rowindex", "2");

	// With an issue picked, the bulk bar floats over the bottom: the last row stops clear of it.
	await rowOf(page, first).getByRole("checkbox").click();
	const bar = page.getByRole("region", { name: "Selected issues" });
	await expect(bar).toContainText("1 issue selected");
	await press(page, "j", titles.length);
	await expectFocused(last);
	await page.keyboard.press("Escape");
	await expect(bar).toBeHidden();
});

async function press(page: Page, key: string, times: number) {
	for (let step = 0; step < times; step++) await page.keyboard.press(key);
}
