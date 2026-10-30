import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";
import { createIssue, startWorkspace, syncBadge, unique } from "./helpers";

test("a member exports the workspace's issues as CSV and JSON from settings", async ({ page }) => {
	const { slug, person } = await startWorkspace(page);
	const title = unique("Export me, please");
	await createIssue(page, title, "First line\nSecond line");
	await expect(page.getByRole("link", { name: title })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.getByRole("link", { name: "Settings" }).first().click();
	await page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: "Export" })
		.click();
	await expect(page).toHaveURL(`/${slug}/settings/export`);

	const csvDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export CSV" }).click();
	const csv = await csvDownload;
	expect(csv.suggestedFilename()).toMatch(new RegExp(`^${slug}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
	const path = await csv.path();
	const text = await readFile(path, "utf8");
	expect(text.startsWith("﻿")).toBe(true);
	const lines = text.slice(1).split("\r\n");
	expect(lines[0]).toBe(
		"Key,Title,Description,Team,Status,Priority,Assignee,Creator,Project,Parent,Labels,Start date,Due date,Estimate,Created,Updated",
	);
	expect(lines[1]).toContain(
		`ENG-1,"${title}","First line\nSecond line",Engineering,Backlog,No priority,`,
	);
	expect(text).toContain(person.email);

	const jsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export JSON" }).click();
	const json = await jsonDownload;
	expect(json.suggestedFilename()).toMatch(new RegExp(`^${slug}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
	const doc = JSON.parse(await readFile(await json.path(), "utf8"));
	expect(doc.format).toBe("gateweave-track-export");
	expect(doc.issues).toHaveLength(1);
	expect(doc.issues[0]).toMatchObject({ key: "ENG-1", title });

	// One team: the file name carries its key.
	await page.getByRole("combobox", { name: "Team" }).selectOption({ label: "Engineering (ENG)" });
	const teamDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export CSV" }).click();
	expect((await teamDownload).suggestedFilename()).toMatch(
		new RegExp(`^${slug}-eng-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
	);
});
