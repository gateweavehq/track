import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

/** The day `offset` days from today, as `YYYY-MM-DD`. */
function day(offset: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offset);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Mar 3" as the app writes a day: the year is added when it is not this year's. */
function short(date: string): string {
	const [year, month, dayOfMonth] = date.split("-").map(Number);
	const parsed = new Date(year ?? 0, (month ?? 1) - 1, dayOfMonth);
	const sameYear = parsed.getFullYear() === new Date().getFullYear();
	return new Intl.DateTimeFormat(
		"en-US",
		sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" },
	).format(parsed);
}

async function setDates(page: Page, slug: string, key: string, start: string, due: string) {
	await page.goto(`/${slug}/issue/${key}`);
	await page.getByLabel("Start date").fill(start);
	await expect(page.getByText("set the start date to")).toBeVisible();
	await page.getByLabel("Due date").fill(due);
	await expect(page.getByText("set the due date to")).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
}

/** Drags from a point on a locator, by a number of pixels sideways, with a real pointer. */
async function dragFrom(page: Page, target: Locator, fromRight: number | "middle", dx: number) {
	const box = await target.boundingBox();
	if (!box) throw new Error("nothing to drag");
	const x = fromRight === "middle" ? box.x + box.width / 2 : box.x + box.width - fromRight;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y, { steps: 4 });
	await page.mouse.move(x + dx, y, { steps: 4 });
	await page.mouse.up();
}

test("the timeline shows issues as bars from start to due date, and dragging changes the dates", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const first = unique("Design the schema");
	const second = unique("Write the importer");
	const third = unique("Think about pricing");
	await createIssue(page, first);
	await createIssue(page, second);
	await createIssue(page, third);

	await setDates(page, slug, "ENG-1", day(0), day(2));
	await setDates(page, slug, "ENG-2", day(1), day(3));

	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Timeline" }).click();
	await expect(page).toHaveURL(/view=timeline/);
	await expect(page.getByRole("button", { name: "Timeline" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Dated issues are bars named with their dates; the issue without dates is counted instead.
	const bar1 = page.getByRole("link", { name: `ENG-1, ${short(day(0))} to ${short(day(2))}` });
	const bar2 = page.getByRole("link", { name: `ENG-2, ${short(day(1))} to ${short(day(3))}` });
	await expect(bar1).toBeVisible();
	await expect(bar2).toBeVisible();
	await expect(page.getByText("1 issue without dates")).toBeVisible();
	await expect(page.getByRole("link", { name: new RegExp(third) })).toBeHidden();
	await expect(page.getByTestId("timeline-today")).toBeVisible();

	// The view survives a reload.
	await page.reload();
	await expect(page).toHaveURL(/view=timeline/);
	await expect(bar1).toBeVisible();

	// A plain click on a bar still opens the issue.
	await bar1.click();
	await expect(page).toHaveURL(/\/issue\/ENG-1$/);
	await page.goBack();
	await expect(bar1).toBeVisible();

	// Dragging the right edge by three days moves only the due date.
	await dragFrom(page, bar1, 3, 3 * 36);
	await expect(
		page.getByRole("link", { name: `ENG-1, ${short(day(0))} to ${short(day(5))}` }),
	).toBeVisible();
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Start date" })).toHaveValue(day(0));
	await expect(page.getByRole("textbox", { name: "Due date" })).toHaveValue(day(5));

	// Dragging the whole bar by two days moves both dates.
	await page.goto(`/${slug}/team/ENG?view=timeline`);
	await dragFrom(page, bar2, "middle", 2 * 36);
	await expect(
		page.getByRole("link", { name: `ENG-2, ${short(day(3))} to ${short(day(5))}` }),
	).toBeVisible();
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("textbox", { name: "Start date" })).toHaveValue(day(3));
	await expect(page.getByRole("textbox", { name: "Due date" })).toHaveValue(day(5));
});

test("the timeline window moves with Previous, Next and Today", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await createIssue(page, unique("Plan the launch"));
	await setDates(page, slug, "ENG-1", day(0), day(2));

	await page.goto(`/${slug}/team/ENG?view=timeline`);
	const bar = page.getByRole("link", { name: /^ENG-1, / });
	const heading = page.getByRole("heading", { level: 2, name: / to / });
	await expect(bar).toBeVisible();
	const opening = await heading.textContent();

	// Four steps ahead, the bar is out of sight and counted as outside.
	for (let step = 0; step < 4; step++)
		await page.getByRole("button", { name: "Next weeks" }).click();
	await expect(heading).not.toHaveText(opening ?? "");
	await expect(bar).toBeHidden();
	await expect(page.getByText("1 dated issue is outside these weeks")).toBeVisible();

	await page.getByRole("button", { name: "Today" }).click();
	await expect(heading).toHaveText(opening ?? "");
	await expect(bar).toBeVisible();
	await page.getByRole("button", { name: "Previous weeks" }).click();
	await expect(heading).not.toHaveText(opening ?? "");
});

test("on a phone the timeline is a list of dated issues", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const title = unique("Renew the domain");
	await createIssue(page, title);
	await setDates(page, slug, "ENG-1", day(1), day(4));
	await page.setViewportSize({ width: 360, height: 740 });

	await page.goto(`/${slug}/team/ENG?view=timeline`);
	const link = page.getByRole("link", { name: new RegExp(title) });
	await expect(link).toBeVisible();
	await expect(link).toContainText(`${short(day(1))} to ${short(day(4))}`);
	await expect(page.getByRole("region", { name: "Timeline" })).toBeHidden();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
