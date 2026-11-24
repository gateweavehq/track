import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace } from "./helpers";

test("R17: an admin sets the assignee separately after seeing the source warning", async ({
	page,
	request,
}) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/teams`);
	await page.getByRole("link", { name: "Sources" }).click();
	await page.getByRole("button", { name: "Add source" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Guard checks");
	await page.getByLabel("Product").selectOption("guard");
	await expect(page.getByLabel("Lowest severity")).toHaveValue("high");
	await expect(page.getByLabel("Close when cleared")).not.toBeChecked();
	await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Create source" }).click();
	const key = page.getByLabel("Source key");
	const original = await key.inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	const source = page.getByRole("region", { name: "Guard checks" });
	await source.getByRole("button", { name: "Make key" }).click();
	const replacement = await key.inputValue();
	expect(replacement).not.toBe(original);
	await page.getByRole("button", { name: "Done" }).click();
	await expect(source.getByRole("button", { name: "Make key" })).toBeDisabled();
	await source.getByRole("button", { name: "Set assignee" }).click();
	await expect(
		page.getByText("Anything this source reports becomes a task for this agent.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toHaveValue("");
	await page.getByRole("button", { name: "Save assignee" }).click();
	const send = (token: string) =>
		request.post("/api/events", {
			headers: { authorization: `Bearer ${token}` },
			data: {
				key: "cert",
				state: "open",
				sentAt: "2026-11-18T00:00:00Z",
				severity: "high",
				title: "Renew certificate",
			},
		});
	expect((await send(original)).status()).toBe(200);
	expect((await send(replacement)).status()).toBe(200);
	await source
		.getByRole("listitem")
		.filter({ hasText: original.slice(0, 12) })
		.getByRole("button", { name: "Revoke" })
		.click();
	await expect(source.getByRole("button", { name: "Revoke" })).toHaveCount(1);
	expect((await send(original)).status()).toBe(404);
	expect((await send(replacement)).status()).toBe(200);
	await page.reload();
	await expect(source).toBeVisible();
	await expect(key).toHaveCount(0);
});

test("WEB-84: the issue shows why its hosted run could not start", async ({ page, request }) => {
	const { slug } = await startWorkspace(page);
	const title = "Check the staging configuration";
	await createIssue(page, title);
	await issueRow(page, title).click();
	await expect(page).toHaveURL(`/${slug}/issue/ENG-1`);

	await page.goto(`/${slug}/settings/sources`);
	await page.getByRole("button", { name: "Add source" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Gateweave Agents");
	await page.getByLabel("Product").selectOption("agents");
	await page.getByRole("button", { name: "Create source" }).click();
	const token = await page.getByLabel("Source key").inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	await page.goto(`/${slug}/issue/ENG-1`);

	const detail = "An admin needs to check the agent's model provider setup.";
	const report = await request.post("/api/events", {
		headers: { authorization: `Bearer ${token}` },
		data: {
			kind: "run",
			state: "failed",
			key: "work-eng-1",
			sentAt: new Date().toISOString(),
			title: "Hosted agent run",
			issue: "ENG-1",
			executor: "agents-hosted",
			agent: "Track Work",
			progress: "Run could not start",
			waitDetail: detail,
		},
	});
	expect(report.status()).toBe(200);
	const runs = page.getByRole("region", { name: "Runs", exact: true });
	await expect(runs.getByRole("img", { name: "Failed", exact: true })).toBeVisible();
	await expect(runs.getByText("Run could not start", { exact: true })).toBeVisible();
	await expect(runs.getByText(detail, { exact: true })).toBeVisible();
});
