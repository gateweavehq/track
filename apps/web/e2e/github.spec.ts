import { createHmac } from "node:crypto";
import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, unique } from "./helpers";

test("a GitHub connection links pull requests to issues and moves them along", async ({
	page,
	request,
}) => {
	const { slug } = await startWorkspace(page);
	const title = unique("Fix the login form");
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();

	// The issue offers a branch name, which links a pull request from that branch to it.
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(`/${slug}/issue/ENG-1`);
	await page.getByRole("button", { name: "Copy branch name" }).click();
	await expect(page.getByText("Branch name copied")).toBeVisible();
	const branch = await page.evaluate(() => navigator.clipboard.readText());
	expect(branch).toMatch(/^eng-1-fix-the-login-form-[a-z0-9]+$/);

	// An admin adds a connection, and is shown once what to set on GitHub.
	await page.goto(`/${slug}/settings/github`);
	await page.getByRole("button", { name: "Add connection" }).click();
	const url = await page.getByLabel("Payload URL").inputValue();
	const secret = await page.getByLabel("Secret").inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	await expect(page.getByLabel("Secret")).toHaveCount(0);
	const connections = page.getByRole("list", { name: "Connections" });
	await expect(connections.getByText("Waiting for the first delivery")).toBeVisible();

	// GitHub opens a pull request from the branch, then merges it, while the issue is open.
	await page.goto(`/${slug}/issue/ENG-1`);
	let deliveries = 0;
	async function deliver(payload: object) {
		const body = JSON.stringify(payload);
		const response = await request.post(url, {
			headers: {
				"content-type": "application/json",
				"x-github-event": "pull_request",
				"x-github-delivery": `delivery-${++deliveries}`,
				"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
			},
			data: body,
		});
		expect(response.status()).toBe(202);
	}
	const pullRequest = {
		id: 42,
		number: 7,
		title: "Handle uppercase emails",
		body: null,
		html_url: "https://github.com/acme/app/pull/7",
		state: "open",
		draft: false,
		merged_at: null,
		head: { ref: branch },
		user: { login: "octocat" },
		created_at: new Date().toISOString(),
	};
	await deliver({
		action: "opened",
		repository: { full_name: "acme/app" },
		pull_request: pullRequest,
	});

	const section = page.getByRole("region", { name: "Pull requests" });
	await expect(section.getByRole("link", { name: "Handle uppercase emails" })).toHaveAttribute(
		"href",
		"https://github.com/acme/app/pull/7",
	);
	await expect(section.getByText("Fixes")).toBeVisible();
	await expect(
		page.locator("p", { hasText: "GitHub changed the status from Backlog to In Review via" }),
	).toBeVisible();

	await deliver({
		action: "closed",
		repository: { full_name: "acme/app" },
		pull_request: { ...pullRequest, state: "closed", merged_at: new Date().toISOString() },
	});
	await expect(section.getByRole("img", { name: "Merged" })).toBeVisible();
	await expect(
		page.locator("p", { hasText: "GitHub changed the status from In Review to Done via" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "acme/app#7" }).first()).toHaveAttribute(
		"href",
		"https://github.com/acme/app/pull/7",
	);

	// The connection says where its last delivery came from.
	await page.goto(`/${slug}/settings/github`);
	await expect(connections.getByText("acme/app")).toBeVisible();
	await expect(connections.getByText(/^Pull request received/)).toBeVisible();
});
