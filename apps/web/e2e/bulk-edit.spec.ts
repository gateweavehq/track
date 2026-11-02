import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

test("several issues are picked in a list and changed, then deleted, at once", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const titles = [unique("Fix the login form"), unique("Update the docs"), unique("Tidy the CSS")];
	for (const title of titles) await createIssue(page, title);
	const [login, docs, css] = titles as [string, string, string];
	await page.goto(`/${slug}/team/ENG`);
	await expect(issueRow(page, css)).toBeVisible();

	// One by its checkbox, one from the keyboard.
	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await expect(bar).toContainText("1 issue selected");
	await issueRow(page, docs).focus();
	await page.keyboard.press("x");
	await expect(bar).toContainText("2 issues selected");

	// P opens the bar's priority menu, which sets both.
	await page.keyboard.press("p");
	await page.getByRole("option", { name: "High" }).click();
	for (const key of ["ENG-1", "ENG-2"]) {
		const row = page.locator("[data-checked]", {
			has: page.getByRole("checkbox", { name: `Select ${key}` }),
		});
		await expect(row.getByRole("button", { name: "Priority: High" })).toBeVisible();
	}
	const third = page.locator("[data-checked]", {
		has: page.getByRole("checkbox", { name: "Select ENG-3" }),
	});
	await expect(third.getByRole("button", { name: "Priority: No priority" })).toBeVisible();

	// A label goes on both.
	await bar.getByRole("button", { name: "Labels" }).click();
	await page.getByPlaceholder(/label/i).fill("Frontend");
	await page.getByRole("option", { name: /Create.*Frontend/ }).click();
	await page.keyboard.press("Escape");
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("complementary", { name: "Properties" })).toContainText("Frontend");
	await page.goto(`/${slug}/team/ENG`);

	// Esc clears the selection; then everything up to the last is picked with Shift.
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click();
	await page.keyboard.press("Escape");
	await expect(bar).toBeHidden();
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click({ modifiers: ["Shift"] });
	await expect(bar).toContainText("3 issues selected");

	await bar.getByRole("button", { name: "Delete 3 issues" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	for (const title of [login, docs, css]) await expect(issueRow(page, title)).toBeHidden();
	await expect(bar).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");
});

test("a table picks issues too: all at once, and the closed ones archived", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const titles = [unique("Plan the launch"), unique("Write the post"), unique("Fix the footer")];
	for (const title of titles) await createIssue(page, title);
	const [plan, post, footer] = titles as [string, string, string];
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Table" }).click();
	await expect(page.getByRole("link", { name: footer })).toBeVisible();

	// Ctrl/Cmd+A picks every issue shown; the filter field keeps it for its own text.
	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.getByPlaceholder("Filter issues").fill("x");
	await page.keyboard.press("ControlOrMeta+a");
	await expect(bar).toBeHidden();
	await page.getByPlaceholder("Filter issues").fill("");
	await page.getByRole("link", { name: plan }).focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(bar).toContainText("3 issues selected");

	// Done for two of them, so only those are offered to the archive.
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click();
	await bar.getByRole("button", { name: "Status" }).click();
	await page.getByRole("option", { name: "Done" }).click();
	await expect(bar.getByRole("button", { name: "Archive 2 closed issues" })).toBeVisible();

	await bar.getByRole("button", { name: "Archive 2 closed issues" }).click();
	await expect(page.getByRole("link", { name: plan })).toBeHidden();
	await expect(page.getByRole("link", { name: post })).toBeHidden();
	await expect(page.getByRole("link", { name: footer })).toBeVisible();
	// The archived ones left with the selection.
	await expect(bar).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");
});

test("a board picks cards too, and moves them to another column at once", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const titles = [unique("Sketch the icon"), unique("Pick the colors"), unique("Name the app")];
	for (const title of titles) await createIssue(page, title);
	await page.goto(`/${slug}/team/ENG`);
	await page.getByRole("button", { name: "Board", exact: true }).click();
	const todo = page.getByRole("region", { name: "Todo" });
	await expect(todo.getByRole("link")).toHaveCount(0);

	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await page.getByRole("checkbox", { name: "Select ENG-3" }).click({ modifiers: ["Shift"] });
	await expect(bar).toContainText("3 issues selected");
	await page.getByRole("checkbox", { name: "Select ENG-2" }).click();
	await expect(bar).toContainText("2 issues selected");

	await bar.getByRole("button", { name: "Status" }).click();
	await page.getByRole("option", { name: "Todo" }).click();
	await expect(todo.getByRole("link")).toHaveCount(2);
	await expect(todo).toContainText("ENG-1");
	await expect(todo).toContainText("ENG-3");
	// Esc goes to an open menu first, so it waits for the status menu to be gone.
	await expect(page.getByRole("dialog")).toBeHidden();
	await page.keyboard.press("Escape");
	await expect(bar).toBeHidden();
	await expect(syncBadge(page)).toHaveText("Live");
});

test("picks follow what is shown, and issues of two teams get no status menu", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const alpha = unique("Alpha");
	const beta = unique("Beta");
	await createIssue(page, alpha);
	await page.getByRole("button", { name: "Create team" }).click();
	const newTeam = page.getByRole("dialog", { name: "New team" });
	await newTeam.getByRole("textbox", { name: "Name" }).fill("Operations");
	await newTeam.getByRole("textbox", { name: "Key" }).fill("OPS");
	await newTeam.getByRole("button", { name: "Create team" }).click();
	await page.goto(`/${slug}/team/OPS`);
	await createIssue(page, beta);
	// Both are assigned to me, so My issues shows issues of two teams.
	for (const [team, title] of [
		["ENG", alpha],
		["OPS", beta],
	] as const) {
		await page.goto(`/${slug}/team/${team}`);
		await issueRow(page, title).focus();
		await page.keyboard.press("a");
		await page.getByRole("option", { name: /\(you\)/ }).click();
		await expect(page.getByRole("listbox")).toBeHidden();
	}
	await page.goto(`/${slug}/my-issues`);
	const bar = page.getByRole("region", { name: "Selected issues" });
	await page.getByRole("checkbox", { name: "Select ENG-1" }).click();
	await page.getByRole("checkbox", { name: "Select OPS-1" }).click();
	await expect(bar).toContainText("2 issues selected");

	// Statuses belong to a team: S opens nothing, and nothing opens once one team is left.
	await expect(bar.getByRole("button", { name: "Status" })).toBeHidden();
	await page.keyboard.press("s");
	await page.getByRole("checkbox", { name: "Select OPS-1" }).click();
	await expect(bar).toContainText("1 issue selected");
	await expect(bar.getByRole("button", { name: "Status" })).toBeVisible();
	await expect(page.getByRole("listbox")).toBeHidden();

	// An issue the filter hides is unpicked, and stays so when the filter is cleared.
	await page.getByRole("checkbox", { name: "Select OPS-1" }).click();
	await expect(bar).toContainText("2 issues selected");
	await page.getByPlaceholder("Filter issues").fill(alpha);
	await expect(bar).toContainText("1 issue selected");
	await page.getByPlaceholder("Filter issues").fill("");
	await expect(issueRow(page, beta)).toBeVisible();
	await expect(bar).toContainText("1 issue selected");

	// Ctrl/Cmd+A belongs to an open menu, not to the list behind it.
	await bar.getByRole("button", { name: "Priority" }).click();
	await expect(page.getByRole("listbox")).toBeVisible();
	await page.getByRole("listbox").press("ControlOrMeta+a");
	await expect(bar).toContainText("1 issue selected");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("listbox")).toBeHidden();
	await issueRow(page, alpha).focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(bar).toContainText("2 issues selected");
});
