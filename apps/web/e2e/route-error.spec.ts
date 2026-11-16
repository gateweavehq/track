import { expect, test } from "./fixtures";
import { createWorkspace, signUp } from "./helpers";

// A page that fails to load (TRK-143). It used to show the error's message, which comes from the
// server: a failed database query's was its statement and every value it was given. The Worker
// tests hold what the server sends; this holds what the browser does with it. The workspace's
// pages are rendered here only, so a failed read reaches them as a server function's error.

/** A server function's answer when it threw, as the server sends it: the error's message alone. */
function thrown(message: string): string {
	return JSON.stringify({
		t: 10,
		i: 0,
		p: {
			k: ["error"],
			v: [{ t: 25, i: 1, s: { message: { t: 1, s: message } }, c: "$TSR/Error" }],
		},
		o: 0,
	});
}

test("a page that could not be loaded shows the failure's reference and none of its message", async ({
	page,
}) => {
	await signUp(page);
	await createWorkspace(page);

	let failing = true;
	await page.route("**/_serverFn/**", async (route) => {
		if (!failing) return route.continue();
		// The server's own answer, with what it would have said had its read of the database failed.
		const response = await route.fetch();
		await route.fulfill({
			response,
			body: thrown("Failed to get session (reference 1a2b3c4d)"),
			headers: { ...response.headers(), "content-type": "application/json" },
		});
	});
	await page.reload();

	await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
	await expect(page.getByText("This page could not be loaded.")).toBeVisible();
	await expect(page.locator("code")).toHaveText("1a2b3c4d");
	await expect(page.getByText("Failed to get session")).toHaveCount(0);

	// The server answers again.
	failing = false;
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("heading", { name: "Create your first team" })).toBeVisible();
});
