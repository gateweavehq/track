import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

/** A day of the current month as `YYYY-MM-DD`. */
function dayOfThisMonth(day: number): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(day)}`;
}

/** The grid cell of a day, found by the full date it announces. */
function dayCell(page: Page, day: string): Locator {
	const [year, month, date] = day.split("-").map(Number);
	const label = new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(
		new Date(year ?? 0, (month ?? 1) - 1, date),
	);
	return page.getByRole("cell").filter({ has: page.getByText(label, { exact: true }) });
}

test("the calendar shows issues on their due date, and dragging one changes it", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const dated = unique("Ship the release");
	const undated = unique("Plan the offsite");
	await createIssue(page, dated);
	await createIssue(page, undated);

	// Give the first issue a due date this month, from its page.
	const due = dayOfThisMonth(10);
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByLabel("Due date").fill(due);
	await expect(page.getByText("set the due date to")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	// The team page offers the calendar, and keeps it in the URL.
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Calendar" }).click();
	await expect(page).toHaveURL(/view=calendar/);
	await expect(page.getByRole("button", { name: "Calendar" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// The issue is on its day; the one without a due date is counted, not shown.
	const link = page.getByRole("link", { name: new RegExp(dated) });
	await expect(dayCell(page, due).getByRole("link", { name: new RegExp(dated) })).toBeVisible();
	await expect(page.getByText("1 issue without a due date")).toBeVisible();
	await expect(page.getByRole("link", { name: new RegExp(undated) })).toBeHidden();

	// Dragging it to another day sets its due date there.
	const moved = dayOfThisMonth(20);
	await link.dragTo(dayCell(page, moved));
	await expect(dayCell(page, moved).getByRole("link", { name: new RegExp(dated) })).toBeVisible();
	await expect(dayCell(page, due).getByRole("link")).toHaveCount(0);
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Due date" })).toHaveValue(moved);
	await expect(page.getByText("set the due date to").first()).toBeVisible();

	// Back on the calendar (the view is remembered), other months have no such issue.
	await page.goto(`/${slug}/team/ENG`);
	const heading = page.getByRole("heading", { level: 2, name: /^[A-Za-z]+ \d{4}$/ });
	await expect(link).toBeVisible();
	const thisMonth = await heading.textContent();
	await page.getByRole("button", { name: "Next month" }).click();
	await expect(heading).not.toHaveText(thisMonth ?? "");
	await expect(link).toBeHidden();
	await page.getByRole("button", { name: "Previous month" }).click();
	await expect(heading).toHaveText(thisMonth ?? "");
	await expect(link).toBeVisible();

	// Today brings the view back from further away.
	await page.getByRole("button", { name: "Next month" }).click();
	await page.getByRole("button", { name: "Next month" }).click();
	await page.getByRole("button", { name: "Today" }).click();
	await expect(heading).toHaveText(thisMonth ?? "");
});

test("on a phone the month is an agenda of the days with issues", async ({ page }) => {
	// Set up at desktop width, where the sidebar's "New issue" button is on screen.
	const { slug } = await startWorkspace(page);
	const dated = unique("Renew the domain");
	await createIssue(page, dated);
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByLabel("Due date").fill(dayOfThisMonth(12));
	await expect(page.getByText("set the due date to")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
	await page.setViewportSize({ width: 360, height: 740 });

	await page.goto(`/${slug}/team/ENG?view=calendar`);
	await expect(page.getByRole("link", { name: new RegExp(dated) })).toBeVisible();
	await expect(page.getByRole("table")).toBeHidden();
	await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);

	// Nothing makes the page scroll sideways.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
