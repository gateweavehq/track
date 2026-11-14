import { expect, test } from "@playwright/test";
import { createIssue, issueRow, syncBadge, unique } from "../e2e/helpers";

// The public demo, end to end: a visitor's sandbox is made, it syncs live between two tabs, and
// the change is kept. This is the whole path of a real workspace (D1, the Durable Object, the
// WebSocket, the local copy), and the demo is the one deployment where a stranger may go through
// it. The sandbox is deleted after a day, like every visitor's.

test("a visitor opens a demo workspace and edits it live in two tabs", async ({
	page,
	context,
}) => {
	await page.goto("/login");
	const start = page.getByRole("button", { name: "Open a demo workspace" });
	test.skip(!(await start.isVisible()), "Not the demo: it has no sandbox to open.");

	await start.click();
	// The opening screen covers the page while the sandbox is made, then hands over to the app.
	await expect(page.getByRole("list", { name: "Progress" })).toBeVisible();
	await expect(page).toHaveURL(/\/acme-[a-z0-9]+/);
	await expect(syncBadge(page)).toHaveText("Live");
	// The welcome card shows once per sandbox; the demo bar stays.
	await page.getByRole("button", { name: "Start exploring" }).click();
	await expect(page.getByRole("link", { name: "Gateweave Cloud" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Deploy your own" })).toBeVisible();
	const workspace = new URL(page.url()).pathname;

	const second = await context.newPage();
	await second.goto(workspace);
	await expect(syncBadge(second)).toHaveText("Live");

	const title = unique("Smoke test");
	await createIssue(page, title);
	await expect(issueRow(second, title)).toBeVisible();

	await page.reload();
	await expect(issueRow(page, title)).toBeVisible();
});
