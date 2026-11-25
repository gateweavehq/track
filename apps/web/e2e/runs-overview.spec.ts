import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, waitForHydration } from "./helpers";

test("WEB-84: the Runs page shows what runs, waits and failed, by executor", async ({
	page,
	request,
}) => {
	const { slug } = await startWorkspace(page);
	for (const title of ["Fix the flaky sign-in test", "Speed up the build"]) {
		await createIssue(page, title);
		await expect(issueRow(page, title)).toBeVisible();
	}

	await page.goto(`/${slug}/settings/sources`);
	await page.getByRole("button", { name: "Add source" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Gateweave Agents");
	await page.getByLabel("Product").selectOption("agents");
	await page.getByRole("button", { name: "Create source" }).click();
	const token = await page.getByLabel("Source key").inputValue();
	await page.getByRole("button", { name: "Done" }).click();

	const report = async (run: Record<string, string>) => {
		const answer = await request.post("/api/events", {
			headers: { authorization: `Bearer ${token}` },
			data: { kind: "run", sentAt: new Date().toISOString(), title: "Agent run", ...run },
		});
		expect(answer.status()).toBe(200);
	};
	await report({
		key: "fix-sign-in",
		issue: "ENG-1",
		state: "running",
		executor: "local-runner",
		agent: "Codex",
		progress: "Running the checks",
	});
	await report({
		key: "build-speed",
		issue: "ENG-2",
		state: "queued",
		executor: "cloud",
		waitReason: "waiting-for-slot",
		waitDetail: "ENG-1 has the slot",
	});
	await report({ key: "old-try", issue: "ENG-2", state: "failed", executor: "local-runner" });
	await report({ key: "done-try", issue: "ENG-1", state: "passed", executor: "agents-hosted" });

	// From the command palette, like every other page. The shortcuts bind once the replica has
	// loaded, so wait for a row it renders before pressing — hydration alone is too early.
	await page.goto(`/${slug}`);
	await waitForHydration(page);
	await expect(issueRow(page, "Fix the flaky sign-in test")).toBeVisible();
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "Command palette" });
	await palette.getByPlaceholder("Search issues or type a command…").fill("Go to Runs");
	await palette.getByRole("option", { name: "Go to Runs" }).click();
	await expect(page).toHaveURL(`/${slug}/runs`);

	const running = page.getByRole("region", { name: "Running" });
	const queued = page.getByRole("region", { name: "Queued" });
	const failed = page.getByRole("region", { name: "Recently failed" });
	await expect(running.getByText("Running the checks")).toBeVisible();
	await expect(running.getByText("Local runner · Codex")).toBeVisible();
	await expect(queued.getByText("Waiting for a slot · ENG-1 has the slot")).toBeVisible();
	await expect(failed.getByText("old-try")).toBeVisible();
	// A passed run has left the page; its issue keeps it.
	await expect(page.getByText("done-try")).toHaveCount(0);

	// The filter offers only the executors on the page: Hosted's only run passed.
	const filter = page.getByLabel("Filter by executor");
	await expect(filter.locator("option")).toHaveText(["All executors", "Local runner", "Cloud"]);
	await filter.selectOption("cloud");
	await expect(page).toHaveURL(`/${slug}/runs?executor=cloud`);
	await expect(queued.getByText("ENG-2")).toBeVisible();
	await expect(running).toHaveCount(0);
	await expect(failed).toHaveCount(0);

	// A row leads to the issue it works on.
	await queued.getByRole("link", { name: /ENG-2/ }).click();
	await expect(page).toHaveURL(`/${slug}/issue/ENG-2`);
});
