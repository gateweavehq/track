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

test("an export brings archived issues whole from the server, and does not drop them offline", async ({
	page,
	network,
}) => {
	const { slug } = await startWorkspace(page);
	const title = unique("Archived, with details");
	await createIssue(page, title, "Only the server keeps this");
	await page.goto(`/${slug}/issue/ENG-1`);
	const properties = page.getByRole("complementary", { name: "Properties" });
	await properties.getByRole("button", { name: /^Backlog/ }).click();
	await page.getByRole("option", { name: "Done" }).click();
	await page.getByRole("button", { name: "Archive issue" }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Archived/ })).toBeVisible();
	await expect(syncBadge(page)).toHaveText("Live");

	await page.goto(`/${slug}/settings/export`);
	const jsonDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export JSON" }).click();
	const doc = JSON.parse(await readFile(await (await jsonDownload).path(), "utf8"));
	expect(doc.issues).toEqual([]);
	expect(doc.archivedIssues).toMatchObject([
		{ key: "ENG-1", title, description: "Only the server keeps this" },
	]);
	expect(doc.notes).toEqual([]);

	// Offline, nothing is downloaded until the person chooses to leave the archived issue out.
	await network.goOffline();
	await expect(syncBadge(page)).toContainText("Offline");
	await page.getByRole("button", { name: "Export CSV" }).click();
	await expect(page.getByText("Not exported: 1 archived issue needs a connection")).toBeVisible();
	const csvDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export without them" }).click();
	const csv = await readFile(await (await csvDownload).path(), "utf8");
	expect(csv.slice(1).split("\r\n").filter(Boolean)).toHaveLength(1);
	await expect(page.getByText("Exported without 1 archived issue")).toBeVisible();
});
