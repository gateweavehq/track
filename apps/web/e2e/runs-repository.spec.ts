import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace } from "./helpers";

test("WEB-84: the Runs page filters a runner's attempts by the repository they were approved for", async ({
	page,
	request,
}) => {
	const { slug } = await startWorkspace(page);
	for (const title of ["Fix the flaky sign-in test", "Document the release steps"]) {
		await createIssue(page, title);
		await expect(issueRow(page, title)).toBeVisible();
	}

	// The runner is an agent member, and reports to an Agents source of the team.
	await page.goto(`/${slug}/settings/agents`);
	await page.getByLabel("Agent name").fill("Runner");
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	await page.goto(`/${slug}/settings/sources`);
	await page.getByRole("button", { name: "Add source" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Runner reports");
	await page.getByLabel("Product").selectOption("agents");
	await page.getByRole("button", { name: "Create source" }).click();
	await page.getByRole("button", { name: "Done" }).click();

	// An admin approves each issue's work for its own repository.
	for (const [issue, repository] of [
		["ENG-1", "acme/site"],
		["ENG-2", "acme/docs"],
	] as const) {
		await page.goto(`/${slug}/issue/${issue}`);
		const properties = page.getByRole("complementary", { name: "Properties" });
		await properties.getByRole("button", { name: "Unassigned" }).click();
		await page.getByRole("option", { name: "Runner" }).click();
		await properties.getByRole("button", { name: "Not approved" }).click();
		const approval = page.getByRole("dialog", { name: "Runner approval" });
		await approval.getByLabel("Repository").fill(repository);
		await approval.getByLabel("Reports to").selectOption({ label: "Runner reports" });
		await approval.getByRole("button", { name: "Approve" }).click();
		await expect(
			properties.getByRole("button", { name: `Local runner · ${repository}` }),
		).toBeVisible();
	}

	// The runner finds and claims both, as it does on its host. Each claim is a queued attempt.
	const runner = async (action: string, data: Record<string, string>) => {
		const answer = await request.post(`/api/work-runs/${action}`, {
			headers: { authorization: `Bearer ${key}` },
			data,
		});
		expect(answer.ok()).toBe(true);
		return (await answer.json()) as { requestId: string };
	};
	for (const issue of ["ENG-1", "ENG-2"]) {
		const { requestId } = await runner("find", { issue });
		await runner("claim", { requestId, claimId: crypto.randomUUID() });
	}

	await page.goto(`/${slug}/runs`);
	const queued = page.getByRole("region", { name: "Queued" });
	await expect(queued.getByRole("listitem")).toHaveCount(2);
	await expect(queued.getByRole("listitem").filter({ hasText: "ENG-1" })).toContainText(
		"acme/site",
	);

	// The filter offers the repositories of the runs on the page, and keeps one in the address.
	const filter = page.getByLabel("Filter by repository");
	await expect(filter.locator("option")).toHaveText(["All repositories", "acme/docs", "acme/site"]);
	await filter.selectOption("acme/site");
	await expect(page).toHaveURL(/[?&]repository=acme%2Fsite/);
	await expect(queued.getByRole("listitem")).toHaveCount(1);
	await expect(queued.getByText("ENG-1")).toBeVisible();
	await expect(queued.getByText("ENG-2")).toHaveCount(0);

	// A reload keeps it, and the executor filter narrows within it.
	await page.reload();
	await expect(page.getByLabel("Filter by repository")).toHaveValue("acme/site");
	await page.getByLabel("Filter by executor").selectOption("local-runner");
	await expect(page).toHaveURL(/repository=acme%2Fsite/);
	await expect(page).toHaveURL(/executor=local-runner/);
	await expect(queued.getByRole("listitem")).toHaveCount(1);
});
