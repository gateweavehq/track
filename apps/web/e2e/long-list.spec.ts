import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { issueRow, startWorkspace, syncBadge } from "./helpers";

// Long enough that the list cannot draw every row at once: the rows near the screen, plus the
// overscan on each side, are a fraction of them.
const COUNT = 150;
// The first few are in progress, so the list has two groups: one to collapse.
const STARTED = 5;
const titles = Array.from(
	{ length: COUNT },
	(_, index) => `Long list ${String(index).padStart(3, "0")}`,
);
// The todo group's issues, in the list's order.
const todo = titles.slice(STARTED);

/** Imports the issues from a CSV file, which is much quicker than a dialog for each. */
async function importIssues(page: Page, slug: string) {
	const csv = [
		"Title,State",
		...titles.map((title, index) => `${title},${index < STARTED ? "In Progress" : "Todo"}`),
		"",
	].join("\r\n");
	await page.goto(`/${slug}/settings/import`);
	await page.getByRole("button", { name: "File", exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "long.csv",
		mimeType: "text/csv",
		buffer: Buffer.from(csv),
	});
	await page.getByRole("button", { name: `Import ${COUNT} issues` }).click();
	await expect(page.getByRole("status")).toHaveText(`Imported ${COUNT} issues.`);
	await expect(syncBadge(page)).toHaveText("Live");
}

/** The list row (its checkbox and link) for an issue; `data-selected` sits on this element. */
function listRow(page: Page, title: string) {
	return page.locator("[data-checked]").filter({ has: issueRow(page, title) });
}

/** Expects the issue to be the selected one, on screen and not under the sticky headers. */
async function expectSelected(page: Page, title: string) {
	const row = listRow(page, title);
	await expect(row).toHaveAttribute("data-selected", "true");
	await expect(issueRow(page, title)).toBeFocused();
	await expect(issueRow(page, title)).toBeInViewport();
	// What is at the row's centre is the row, or something in it.
	const uncovered = await row.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		return hit !== null && element.contains(hit);
	});
	expect(uncovered, `${title} is not covered`).toBe(true);
}

async function press(page: Page, key: string, times: number) {
	for (let step = 0; step < times; step++) await page.keyboard.press(key);
}

test("rows are measured, so the keyboard lands on them at a larger font size", async ({ page }) => {
	// A reader's larger default font: rows are 2.5rem, 50 pixels here rather than 40.
	await page.addInitScript(() => {
		document.addEventListener("DOMContentLoaded", () => {
			const style = document.createElement("style");
			style.textContent = "html { font-size: 20px !important; }";
			document.head.append(style);
		});
	});
	const { slug } = await startWorkspace(page);
	await importIssues(page, slug);
	await page.goto(`/${slug}/team/ENG`);
	const first = todo[0] as string;
	await expect(issueRow(page, first)).toBeVisible();
	expect((await listRow(page, first).boundingBox())?.height).toBe(50);

	// Down past rows that were not rendered, then back up under the sticky headers.
	await issueRow(page, first).focus();
	await press(page, "j", 100);
	await expectSelected(page, todo[100] as string);
	await press(page, "k", 60);
	await expectSelected(page, todo[40] as string);
	await press(page, "j", todo.length);
	await expectSelected(page, todo[todo.length - 1] as string);
	await press(page, "k", todo.length - 1);
	await expectSelected(page, first);
});

test("a long list renders only the rows near the screen, and the keyboard still reaches the rest", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await importIssues(page, slug);
	await page.goto(`/${slug}/team/ENG`);
	const first = todo[0] as string;
	await expect(issueRow(page, first)).toBeVisible();

	// Only the rows near the screen are in the page.
	const rendered = page.locator("[data-checked]");
	expect(await rendered.count()).toBeLessThan(COUNT / 2);
	await expect(issueRow(page, todo[100] as string)).toHaveCount(0);

	// J moves the selection down through rows that are not rendered yet; each one scrolls in.
	await issueRow(page, first).focus();
	await press(page, "j", 100);
	await expectSelected(page, todo[100] as string);
	await expect(issueRow(page, first)).toHaveCount(0);
	// Screen readers hear where it is in the whole list: both headers and every row count.
	const issues = page.getByRole("list", { name: "Issues" });
	await expect(
		issues.getByRole("listitem").filter({ has: issueRow(page, todo[100] as string) }),
	).toHaveAttribute("aria-posinset", String(STARTED + 100 + 3));
	await expect(listRow(page, todo[100] as string)).toHaveAttribute(
		"aria-setsize",
		String(COUNT + 2),
	);
	expect(await rendered.count()).toBeLessThan(COUNT / 2);

	// K moves back up, past rows that are off screen now.
	await press(page, "k", 80);
	await expectSelected(page, todo[20] as string);

	// The group's header sticks at the top while its rows scroll beneath it.
	await expect(page.getByRole("heading").filter({ hasText: "Todo" })).toBeInViewport();

	// X picks a row; Shift+X picks everything from there to a row far below, unrendered between.
	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.keyboard.press("x");
	await expect(bar).toContainText("1 issue selected");
	await press(page, "j", 110);
	await expectSelected(page, todo[130] as string);
	await page.keyboard.press("Shift+X");
	await expect(bar).toContainText("111 issues selected");
	await expect(listRow(page, todo[130] as string)).toHaveAttribute("data-checked", "true");
	await page.keyboard.press("Escape");
	await expect(bar).toBeHidden();

	// Alt with an arrow moves the selected issue, and it keeps the selection where it lands.
	await page.keyboard.press("Alt+ArrowUp");
	await expect(listRow(page, todo[130] as string)).toHaveAttribute("data-selected", "true");
	await page.keyboard.press("j");
	await expectSelected(page, todo[129] as string);

	// Ctrl/Cmd+A adds every shown issue to the picks: one picked in a collapsed group stays.
	const started = titles[0] as string;
	await press(page, "k", COUNT);
	await expectSelected(page, started);
	await page.keyboard.press("x");
	await expect(bar).toContainText("1 issue selected");
	await page.locator("h2 button[aria-expanded]").filter({ hasText: "In Progress" }).click();
	await expect(issueRow(page, started)).toHaveCount(0);
	await issueRow(page, first).focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(bar).toContainText(`${todo.length + 1} issues selected`);

	// J from the top reaches the end of the list.
	await press(page, "j", todo.length - 1);
	await expectSelected(page, todo[todo.length - 1] as string);
});
