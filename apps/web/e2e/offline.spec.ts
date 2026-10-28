import { expect, test } from "./fixtures";
import {
	createIssue,
	issueRow,
	startWorkspace,
	syncBadge,
	unique,
	waitForServiceWorker,
} from "./helpers";

// Offline is `network.goOffline()` (see network.ts): the browser loses its network, as with
// `context.setOffline(true)`, and the open sync sockets are closed too. Stopping the server
// instead would also fail the tests' own page loads, and could not be undone within a run.

test("an edit made offline survives a reload and syncs when the connection returns", async ({
	page,
	context,
	network,
}) => {
	const { slug } = await startWorkspace(page);
	// A reload without a connection is answered by the service worker, so wait until it is active.
	await waitForServiceWorker(page);

	await network.goOffline();
	await expect(syncBadge(page)).toContainText("Offline");
	const title = unique("Written offline");
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();
	await expect(syncBadge(page)).toContainText("Offline");
	await expect(syncBadge(page)).toContainText("1 unsynced");

	// The pending edit is on the device, not just in memory.
	await page.reload();
	await expect(issueRow(page, title)).toBeVisible();
	await expect(syncBadge(page)).toContainText("1 unsynced");

	await network.goOnline();
	await expect(syncBadge(page)).toHaveText("Live");

	// The server has it now: a new tab, which only reads what the leader tab wrote, shows it.
	const other = await context.newPage();
	await other.goto(`/${slug}/team/ENG`);
	await expect(issueRow(other, title)).toBeVisible();
	await expect(syncBadge(other)).toHaveText("Live");
});

test("the workspace used last opens with no connection, and server-only pages say so", async ({
	page,
	context,
	network,
}) => {
	const { slug, name } = await startWorkspace(page);
	const title = unique("Kept on the device");
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");
	await waitForServiceWorker(page);

	// Close the tab, then lose the connection: what follows is a cold start, as from an installed app.
	await page.close();
	await network.goOffline();
	const cold = await context.newPage();
	await cold.goto("/");
	await expect(cold).toHaveURL(new RegExp(`/${slug}(/team/ENG)?$`));
	await expect(cold.getByRole("button", { name })).toBeVisible();
	await expect(issueRow(cold, title)).toBeVisible();
	await expect(syncBadge(cold)).toContainText("Offline");

	// Pages that need the server explain themselves instead of failing.
	await cold.goto(`/${slug}/settings/members`);
	await expect(cold.getByRole("heading", { name: "You're offline" })).toBeVisible();
});

test("signing out forgets the workspace on this device", async ({ page, context, network }) => {
	const { slug, name } = await startWorkspace(page);
	await waitForServiceWorker(page);

	await page.getByRole("button", { name }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);

	await network.goOffline();
	const cold = await context.newPage();
	await cold.goto(`/${slug}`);
	await expect(cold.getByRole("heading", { name: "You're offline" })).toBeVisible();
	await expect(cold.getByRole("button", { name })).toBeHidden();
	await expect(syncBadge(cold)).toBeHidden();
});
