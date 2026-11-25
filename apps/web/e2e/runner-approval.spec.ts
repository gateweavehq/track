import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace } from "./helpers";

test("WEB-87: an admin approves an agent's assignment for its runner on the issue page", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const title = "Fix the flaky sign-in test";
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();

	// The runner is an agent member, and reports to an Agents source of the team.
	await page.goto(`/${slug}/settings/agents`);
	await page.getByLabel("Agent name").fill("Runner");
	await page.getByRole("button", { name: "Create agent" }).click();
	await page.getByRole("button", { name: "Done" }).click();
	await page.goto(`/${slug}/settings/sources`);
	await page.getByRole("button", { name: "Add source" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Runner reports");
	await page.getByLabel("Product").selectOption("agents");
	await page.getByRole("button", { name: "Create source" }).click();
	await page.getByRole("button", { name: "Done" }).click();

	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	// A person's assignment has nothing for a runner to take.
	await expect(properties.getByText("Runner", { exact: true })).toHaveCount(0);
	await properties.getByRole("button", { name: "Unassigned" }).click();
	await page.getByRole("option", { name: "Runner" }).click();

	await properties.getByRole("button", { name: "Not approved" }).click();
	const approval = page.getByRole("dialog", { name: "Runner approval" });
	await approval.getByLabel("Repository").fill("acme/site");
	await approval.getByLabel("Reports to").selectOption({ label: "Runner reports" });
	await approval.getByLabel("Runs on").selectOption("cloud");
	await approval.getByRole("button", { name: "Approve" }).click();
	await expect(properties.getByRole("button", { name: "Cloud · acme/site" })).toBeVisible();

	// Track keeps the approval: the row reads it again after a reload.
	await page.reload();
	await properties.getByRole("button", { name: "Cloud · acme/site" }).click();
	await expect(approval.getByText("Approved for this assignment")).toBeVisible();
	await expect(approval.getByText("Runner reports")).toBeVisible();
	await expect(approval.getByText("No attempt yet.")).toBeVisible();
});
