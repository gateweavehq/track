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

/** The label of the new-workspace form's checkbox for the guided team. */
export const GUIDED_START = "Start with a team and a few issues that show you around";

/** A team's issue list in the workspace with this slug, whatever the team's key. */
export function teamUrl(slug: string): RegExp {
	return new RegExp(`/${slug}/team/[A-Z][A-Z0-9]*$`);
}

/**
 * Creates a workspace from `/`. Most tests want it empty and wait for the "first team" screen; with
 * `guided`, it starts with the guided team, and this waits for that team's issue list.
 */
export async function createWorkspace(
	page: Page,
	{ guided = false } = {},
): Promise<{ name: string; slug: string }> {
	const slug = unique("ws");
	const name = `Workspace ${slug}`;
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("URL").fill(slug);
	await page.getByLabel(GUIDED_START).setChecked(guided);
	await page.getByRole("button", { name: "Create workspace" }).click();
	if (guided) {
		await expect(page).toHaveURL(teamUrl(slug));
	} else {
		await expect(page).toHaveURL(`/${slug}`);
		await expect(page.getByRole("heading", { name: "Create your first team" })).toBeVisible();
	}
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

/**
 * Invites a new person from the owner's page and has them sign up and join on `guestPage`, a page
 * of another browser context. Email is off in the test setup, so the invitation is a link to share.
 */
export async function joinByInvitation(
	owner: Page,
	guestPage: Page,
	workspace: { slug: string; name: string },
): Promise<Person> {
	await owner.goto(`/${workspace.slug}/settings/members`);
	const guest = newPerson("guest");
	await owner.getByLabel("Email address").fill(guest.email);
	await owner.getByRole("button", { name: "Create invite link" }).click();
	const link = await owner.getByLabel("Invite link").inputValue();

	await guestPage.goto(link);
	await guestPage.getByRole("link", { name: "Create an account" }).click();
	await waitForHydration(guestPage);
	await guestPage.getByLabel("Name").fill(guest.name);
	await guestPage.getByLabel("Password").fill(guest.password);
	await guestPage.getByRole("button", { name: "Create account" }).click();
	await guestPage.getByRole("button", { name: `Join ${workspace.name}` }).click();
	await expect(syncBadge(guestPage)).toHaveText("Live");
	return guest;
}

/** Signs up, creates a workspace and its first team: the start of most tests. */
export async function startWorkspace(page: Page) {
	const person = await signUp(page);
	const workspace = await createWorkspace(page);
	await createFirstTeam(page, workspace.slug);
	await expect(syncBadge(page)).toHaveText("Live");
	return { person, ...workspace };
}
