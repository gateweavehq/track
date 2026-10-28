import { expect, type Page } from "@playwright/test";

/** Short and unique per call, so tests never share users or workspaces. */
export function unique(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Person {
	name: string;
	email: string;
	password: string;
}

export function newPerson(label = "user"): Person {
	const id = unique(label);
	return { name: `Test ${id}`, email: `${id}@example.test`, password: "correct-horse-battery" };
}

/**
 * Waits until React has taken over a server-rendered page. Before that, a click on a submit
 * button is a plain form submission that reloads the page and throws away what was typed.
 */
export async function waitForHydration(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const main = document.querySelector("main");
		return Boolean(main && Object.keys(main).some((key) => key.startsWith("__reactProps")));
	});
}

/**
 * Signs up on the sign-up form of `/login`. Email is off in the test setup, so there is nothing
 * to verify, and the app lands on `/`.
 */
export async function signUp(page: Page, person: Person = newPerson()): Promise<Person> {
	await page.goto("/login?mode=sign-up");
	await waitForHydration(page);
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	return person;
}

/** Creates a workspace from `/` and waits for the "first team" screen. Returns its slug. */
export async function createWorkspace(page: Page): Promise<{ name: string; slug: string }> {
	const slug = unique("ws");
	const name = `Workspace ${slug}`;
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("URL").fill(slug);
	await page.getByRole("button", { name: "Create workspace" }).click();
	await expect(page).toHaveURL(`/${slug}`);
	await expect(page.getByRole("heading", { name: "Create your first team" })).toBeVisible();
	return { name, slug };
}

/** Creates the first team of a new workspace and waits for its (empty) issue list. */
export async function createFirstTeam(page: Page, slug: string, key = "ENG"): Promise<void> {
	await page.getByRole("textbox", { name: "Name" }).fill("Engineering");
	await page.getByRole("textbox", { name: "Key" }).fill(key);
	await page.getByRole("main").getByRole("button", { name: "Create team" }).click();
	await expect(page).toHaveURL(`/${slug}/team/${key}`);
}

/** Creates an issue from the sidebar's "New issue" button. */
export async function createIssue(page: Page, title: string, description?: string): Promise<void> {
	await page.getByRole("button", { name: "New issue" }).first().click();
	const dialog = page.getByRole("dialog", { name: "New issue" });
	await dialog.getByLabel("Title").fill(title);
	if (description) await dialog.getByLabel("Description").fill(description);
	await dialog.getByRole("button", { name: "Create issue" }).click();
	await expect(dialog).toBeHidden();
}

/** A row of the issue list. */
export function issueRow(page: Page, title: string) {
	return page.getByRole("link", { name: title });
}

/** The sync badge in the sidebar: its text is "Live", "Offline", "Offline · 1 unsynced", … */
export function syncBadge(page: Page) {
	return page.locator("p", { hasText: /^(Live|Connecting|Offline)/ }).first();
}

/**
 * Waits for the service worker to be installed and active, which means the build's files and the
 * app shell are cached. Only then can a page load without a connection.
 */
export async function waitForServiceWorker(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
}

/** Signs up, creates a workspace and its first team: the start of most tests. */
export async function startWorkspace(page: Page) {
	const person = await signUp(page);
	const workspace = await createWorkspace(page);
	await createFirstTeam(page, workspace.slug);
	await expect(syncBadge(page)).toHaveText("Live");
	return { person, ...workspace };
}
