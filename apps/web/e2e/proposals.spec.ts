import { expect, test } from "./fixtures";
import { createIssue, issueRow, startWorkspace, syncBadge, unique } from "./helpers";

/** Calls one MCP tool as an agent, over plain HTTP like any MCP client would. */
async function callTool(
	origin: string,
	key: string,
	name: string,
	args: Record<string, unknown>,
): Promise<void> {
	const url = `${origin}/mcp`;
	const headers: Record<string, string> = {
		authorization: `Bearer ${key}`,
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	// Responses are JSON or a server-sent event stream with one `data:` line per message.
	async function rpc(body: Record<string, unknown>): Promise<unknown> {
		const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
		const text = await response.text();
		expect(response.status, text).toBeLessThan(300);
		const session = response.headers.get("mcp-session-id");
		if (session) headers["mcp-session-id"] = session;
		const data = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		return JSON.parse(data[data.length - 1] ?? (text || "null"));
	}

	await rpc({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "e2e", version: "1.0.0" },
		},
	});
	await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
	const result = (await rpc({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name, arguments: args },
	})) as { result?: { isError?: boolean } };
	expect(result.result?.isError ?? false, JSON.stringify(result)).toBe(false);
}

test("an agent's proposal shows in the list, and accepting it applies the change", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);
	const title = unique("Needs triage");
	await createIssue(page, title);
	await expect(issueRow(page, title)).toBeVisible();

	// An admin makes an agent and sets its priority changes to wait for a person.
	await page.goto(`/${slug}/settings/agents`);
	await page.getByLabel("Agent name").fill("Triage");
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	const priority = page.getByRole("checkbox", { name: "Priority", exact: true });
	await priority.click();
	await expect(priority).toBeChecked();
	// The setting reaches the server before the agent acts on it.
	await expect(syncBadge(page)).toHaveText("Live");

	const proposals = page.getByRole("link", { name: /^Proposals/ });
	await expect(proposals).not.toContainText("1");

	await callTool(new URL(page.url()).origin, key, "update_issue", {
		workspace: slug,
		key: "ENG-1",
		priority: "high",
	});

	await expect(proposals).toContainText("1");
	await proposals.click();
	await expect(page).toHaveURL(`/${slug}/proposals`);
	await expect(page.getByRole("heading", { name: "Proposals" })).toBeVisible();
	await expect(page.getByRole("link", { name: new RegExp(`ENG-1\\s*${title}`) })).toBeVisible();
	await expect(page.getByText("proposes the priority")).toBeVisible();

	await page.getByRole("button", { name: "Accept" }).click();
	await expect(page.getByRole("heading", { name: "Nothing to decide" })).toBeVisible();
	await expect(proposals).not.toContainText("1");

	// The change was made as the person who accepted it.
	await page.goto(`/${slug}/team/ENG`);
	await expect(page.getByRole("button", { name: "Priority: High" })).toBeVisible();
});
