import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createIssue,
	issueRow,
	startWorkspace,
	syncBadge,
	unique,
	waitForHydration,
} from "./helpers";

// One tab of a browser holds the lock and the only connection, for as long as it stays open. These
// are the ways that tab can be left behind by a session that ended, and what the next sign-in finds.

async function signIn(page: Page, person: { email: string; password: string }) {
	await page.goto("/login");
	await waitForHydration(page);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/login/);
}

/** How many of this workspace's issues are in IndexedDB, in every replica this browser holds. */
function storedIssues(page: Page) {
	return page.evaluate(async () => {
		const names = (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : []));
		let total = 0;
		for (const name of names.filter((each) => each.startsWith("track:"))) {
			total += await new Promise<number>((resolve, reject) => {
				const open = indexedDB.open(name);
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					if (!db.objectStoreNames.contains("issue")) {
						db.close();
						resolve(0);
						return;
					}
					const count = db.transaction("issue").objectStore("issue").count();
					count.onsuccess = () => {
						db.close();
						resolve(count.result);
					};
				};
			});
		}
		return total;
	});
}

test("signing out in one tab leaves no tab in the way of the next sign-in", async ({
	page: left,
	context,
}) => {
	const { person, slug, name } = await startWorkspace(left);
	const title = unique("Before signing out");
	await createIssue(left, title);
	await expect(syncBadge(left)).toHaveText("Live");

	// This tab came first, so it leads. The second signs out, and comes back in the same tab.
	const other = await context.newPage();
	await other.goto(`/${slug}/team/ENG`);
	await expect(issueRow(other, title)).toBeVisible();
	await other.getByRole("button", { name }).click();
	await other.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(other).toHaveURL(/\/login/);
	// The tab left open follows: this device's copy is gone, and it must not go on from memory.
	await expect(left).toHaveURL(/\/login/);
	await expect(left.getByText(title)).toBeHidden();
	await signIn(other, person);

	// The tab that came back, and one opened after it, both reach the workspace.
	await other.goto(`/${slug}/team/ENG`);
	await expect(issueRow(other, title)).toBeVisible();
	await expect(syncBadge(other)).toHaveText("Live");
	const opened = await context.newPage();
	await opened.goto(`/${slug}/team/ENG`);
	await expect(issueRow(opened, title)).toBeVisible();
	await expect(syncBadge(opened)).toHaveText("Live");

	// What they show is on this device too, not only in the memory of the tab that leads.
	await expect.poll(() => storedIssues(opened)).toBeGreaterThan(0);

	// Reloaded, the tab left on the sign-in page goes back to where it was, one more tab like them.
	await left.reload();
	await expect(issueRow(left, title)).toBeVisible();
	await expect(syncBadge(left)).toHaveText("Live");

	// And an edit made anywhere still reaches everywhere.
	const after = unique("After signing in");
	await createIssue(opened, after);
	await expect(issueRow(other, after)).toBeVisible();
	await expect(issueRow(left, after)).toBeVisible();
});

test("a tab whose copy went while it still has access builds it again", async ({
	page: left,
	context,
}) => {
	const { slug } = await startWorkspace(left);
	const title = unique("Before the copy went");
	await createIssue(left, title);
	await expect(syncBadge(left)).toHaveText("Live");
	const other = await context.newPage();
	await other.goto(`/${slug}/team/ENG`);
	await expect(issueRow(other, title)).toBeVisible();

	// Started and not waited for, as both tabs reload once it happens.
	const reloaded = Promise.all([left.waitForEvent("load"), other.waitForEvent("load")]);
	await other.evaluate(() => {
		void indexedDB.databases().then((databases) => {
			for (const { name } of databases) {
				if (name?.startsWith("track:")) indexedDB.deleteDatabase(name);
			}
		});
	});
	await reloaded;

	await expect(issueRow(left, title)).toBeVisible();
	await expect(syncBadge(left)).toHaveText("Live");
	await expect.poll(() => storedIssues(left)).toBeGreaterThan(0);
	const after = unique("After the copy came back");
	await createIssue(left, after);
	await expect(issueRow(other, after)).toBeVisible();
});

test("a session that ended elsewhere does not keep the next sign-in out", async ({
	page: left,
	context,
}) => {
	const { person, slug } = await startWorkspace(left);
	const title = unique("Before the session ended");
	await createIssue(left, title);
	// Reloaded, so nothing from making the workspace is still moving when the session ends. Any
	// navigation after that rightly goes to the sign-in page, which would release the lock this tab
	// is here to hold.
	await left.reload();
	await expect(issueRow(left, title)).toBeVisible();
	await expect(syncBadge(left)).toHaveText("Live");

	// As when a provider signs someone out: the session ends and this browser's storage stays.
	await left.evaluate(async () => {
		await fetch("/api/auth/sign-out", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
	});
	await expect(left.getByRole("heading", { name: "Your session has ended" })).toBeVisible();

	const opened = await context.newPage();
	await signIn(opened, person);
	await opened.goto(`/${slug}/team/ENG`);
	await expect(issueRow(opened, title)).toBeVisible();
	await expect(syncBadge(opened)).toHaveText("Live");

	// The tab that was asking for a sign-in has its answer too, and still holds the connection.
	await expect(issueRow(left, title)).toBeVisible();
	await expect(syncBadge(left)).toHaveText("Live");
	const after = unique("After signing in");
	await createIssue(opened, after);
	await expect(issueRow(left, after)).toBeVisible();
	await expect.poll(() => storedIssues(opened)).toBeGreaterThan(1);
});
