import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";
import {
	createFirstTeam,
	createIssue,
	createWorkspace,
	issueRow,
	startWorkspace,
	syncBadge,
	unique,
} from "./helpers";

// A spreadsheet from another tracker: its own column names, a parent named by key, and dates.
const CSV = [
	"Key,Summary,State,Priority,Tags,Parent,Created",
	"OLD-1,Plan the launch,In Progress,High,Launch,,2024-03-01T10:00:00Z",
	'OLD-2,Write the announcement,To Do,Low,"Launch, Docs",OLD-1,2024-03-02T10:00:00Z',
	"",
].join("\r\n");

test("an admin imports issues from a CSV file, and importing it again skips them", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/import`);
	const chooseFile = async () => {
		await page.getByRole("button", { name: "File", exact: true }).click();
		await page.locator('input[type="file"]').setInputFiles({
			name: "old-tracker.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(CSV),
		});
	};

	await chooseFile();
	await expect(page.getByText("From CSV: 2 issues.")).toBeVisible();
	await expect(page.getByText("New labels: Launch, Docs.")).toBeVisible();
	await expect(page.getByLabel("Into team")).toHaveValue(/.+/);
	await page.getByRole("button", { name: "Import 2 issues" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 2 issues.");
	await expect(syncBadge(page)).toHaveText("Live");

	// Oldest first, so the numbers follow the old tracker's, with the parent and dates it had.
	await page.goto(`/${slug}/issue/ENG-2`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Write the announcement");
	await expect(page.getByRole("link", { name: /Sub-issue of ENG-1/ })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Properties" }).getByRole("button", { name: /^Todo/ }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Activity" }).locator("time")).toHaveAttribute(
		"datetime",
		"2024-03-02T10:00:00.000Z",
	);
	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Plan the launch");
	await expect(
		page.getByRole("region", { name: "Sub-issues" }).getByRole("link", {
			name: "Write the announcement",
		}),
	).toBeVisible();

	// The same file again brings in nothing.
	await page.goto(`/${slug}/settings/import`);
	await chooseFile();
	await expect(
		page.getByText("Everything here was imported before. There is nothing new to bring in."),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("a workspace's JSON export moves into another workspace with comments, relations and teams", async ({
	page,
}) => {
	const { name } = await startWorkspace(page);
	const api = unique("Ship the API");
	const mockups = unique("Draw the mockups");
	await createIssue(page, api);
	await createIssue(page, mockups);
	await expect(issueRow(page, mockups)).toBeVisible();

	// The API waits for the mockups, and has a comment.
	await page.getByRole("link", { name: api }).click();
	await page.getByRole("button", { name: "Add relation" }).click();
	await page.getByRole("option", { name: "Blocked by…" }).click();
	await page.getByPlaceholder("Find the issue that blocks it…").fill(mockups);
	await page.getByRole("option", { name: mockups }).click();
	await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Waiting on design.");
	await page.getByRole("button", { name: "Comment", exact: true }).click();
	await expect(page.getByRole("article", { name: /^Comment by/ })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.getByRole("link", { name: "Settings" }).first().click();
	await page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: "Export" })
		.click();
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export JSON" }).click();
	const json = await readFile(await (await download).path(), "utf8");

	// A second workspace, whose only team is not Engineering.
	await page.goto("/");
	const target = await createWorkspace(page);
	await createFirstTeam(page, target.slug, "CORE");
	await page.goto(`/${target.slug}/settings/import`);
	await page.getByRole("button", { name: "File", exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "export.json",
		mimeType: "application/json",
		buffer: Buffer.from(json),
	});
	await expect(page.getByText(`From ${name}: 2 issues, 1 comment and 1 relation.`)).toBeVisible();
	await expect(page.getByLabel("Into team")).toHaveValue("source-teams");
	await expect(page.getByText("New teams: Engineering (ENG).")).toBeVisible();
	await page.getByRole("button", { name: "Import 2 issues" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 2 issues, 1 comment and 1 relation.");
	await expect(syncBadge(page)).toHaveText("Live");

	// The issues keep their team and their order, the comment says who wrote it, and the API is
	// still blocked by the mockups.
	await page.goto(`/${target.slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(api);
	await expect(page.getByRole("list", { name: "Blocked by" }).getByRole("link")).toHaveText(
		new RegExp(mockups),
	);
	const comment = page.getByRole("article", { name: /^Comment by/ });
	await expect(comment).toContainText(`wrote in ${name}:`);
	await expect(comment).toContainText("Waiting on design.");
});

test("a CSV file without titles is explained, not imported", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/import`);
	await page.getByRole("button", { name: "File", exact: true }).click();
	await page.locator('input[type="file"]').setInputFiles({
		name: "keys.csv",
		mimeType: "text/csv",
		buffer: Buffer.from("Key,Status\nOLD-1,Done\n"),
	});
	await expect(page.getByRole("alert")).toHaveText(
		'The file needs a column of titles, named "Title", "Summary" or "Name".',
	);
});

// GitHub and Linear are stood in for at the browser's edge, so the tests need neither, nor a token.
test("an admin imports a GitHub repository's issues and comments", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const asked: (string | null)[] = [];
	await page.context().route("https://api.github.com/**", async (route) => {
		const url = new URL(route.request().url());
		asked.push(route.request().headers().authorization ?? null);
		const answers: Record<string, unknown> = {
			"/repos/acme/api": { id: 42, full_name: "acme/api" },
			"/repos/acme/api/issues": [
				{
					number: 1,
					title: "Crash on save",
					body: "Saving a **large** file crashes.",
					state: "open",
					labels: [{ name: "bug", color: "d73a4a" }],
					assignee: { login: "octocat" },
					milestone: null,
					created_at: "2024-05-01T09:00:00Z",
					html_url: "https://github.com/acme/api/issues/1",
					comments: 1,
				},
				{ number: 2, title: "Add retries", pull_request: {}, comments: 0 },
			],
			"/repos/acme/api/issues/comments": [
				{
					id: 9,
					issue_url: "https://api.github.com/repos/acme/api/issues/1",
					body: "Same here.",
					user: { login: "hubot" },
					created_at: "2024-05-02T09:00:00Z",
				},
			],
		};
		const body = answers[url.pathname];
		await route.fulfill(
			body
				? { json: body, headers: { "Access-Control-Allow-Origin": "*" } }
				: { status: 404, json: {}, headers: { "Access-Control-Allow-Origin": "*" } },
		);
	});

	await page.goto(`/${slug}/settings/import`);
	await page.getByLabel("Repository").fill("https://github.com/acme/api");
	await page.getByLabel("Access token").fill("ghp_test");
	await page.getByRole("button", { name: "Read issues" }).click();
	await expect(page.getByText("From GitHub: 1 issue and 1 comment.")).toBeVisible();
	await expect(page.getByText("1 pull request left out.")).toBeVisible();
	expect(asked.every((authorization) => authorization === "Bearer ghp_test")).toBe(true);
	await page.getByRole("button", { name: "Import 1 issue" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 1 issue and 1 comment.");

	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Crash on save");
	await expect(page.getByRole("link", { name: "acme/api#1" })).toHaveAttribute(
		"href",
		"https://github.com/acme/api/issues/1",
	);
	await expect(page.getByText("Assigned in GitHub to octocat.")).toBeVisible();
	await expect(page.getByText("hubot wrote in GitHub:")).toBeVisible();
	await expect(page.getByText("Same here.")).toBeVisible();
});

test("an admin picks a Linear team and imports its issues", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.context().route("https://api.linear.app/graphql", async (route) => {
		const { query } = route.request().postDataJSON() as { query: string };
		const operation = /query (\w+)/.exec(query)?.[1];
		const list = (nodes: unknown[]) => ({
			nodes,
			pageInfo: { hasNextPage: false, endCursor: null },
		});
		const data =
			operation === "Teams"
				? { teams: list([{ id: "t-ops", key: "OPS", name: "Operations" }]) }
				: operation === "Issues"
					? {
							issues: list([
								{
									id: "a",
									identifier: "OPS-7",
									title: "Rotate the keys",
									description: "Every quarter.",
									priority: 2,
									estimate: 3,
									dueDate: "2024-07-01",
									createdAt: "2024-06-01T09:00:00.000Z",
									url: "https://linear.app/acme/issue/OPS-7",
									state: { name: "In Review", type: "started" },
									assignee: null,
									project: { name: "Security" },
									parent: null,
									labels: { nodes: [{ name: "Chore", color: "#5e6ad2" }] },
								},
							]),
						}
					: { comments: list([]) };
		await route.fulfill({ json: { data }, headers: { "Access-Control-Allow-Origin": "*" } });
	});

	await page.goto(`/${slug}/settings/import`);
	await page.getByRole("button", { name: "Linear" }).click();
	await page.getByLabel("API key").fill("lin_api_test");
	await page.getByRole("button", { name: "Connect" }).click();
	await expect(page.getByLabel("Linear team")).toHaveValue("t-ops");
	await page.getByRole("button", { name: "Read issues" }).click();
	await expect(page.getByText("From Linear: 1 issue.")).toBeVisible();
	await expect(page.getByText("New labels: Chore.")).toBeVisible();
	await expect(page.getByText("New projects: Security.")).toBeVisible();
	await page.getByRole("button", { name: "Import 1 issue" }).click();
	await expect(page.getByRole("status")).toHaveText("Imported 1 issue.");

	await page.goto(`/${slug}/issue/ENG-1`);
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Rotate the keys");
	const properties = page.getByRole("complementary", { name: "Properties" });
	await expect(properties.getByRole("button", { name: /^In Review/ })).toBeVisible();
	await expect(properties.getByRole("button", { name: /^High/ })).toBeVisible();
	await expect(page.getByRole("link", { name: "OPS-7" })).toBeVisible();
});
