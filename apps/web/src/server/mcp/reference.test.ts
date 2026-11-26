import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	listServerTools,
	REWRITE_COMMAND,
	readToolsBlock,
	renderToolsTable,
	TOOL_NEEDS,
} from "./reference";

const doc = new URL("../../../../../docs/mcp.md", import.meta.url);

describe("docs/mcp.md", () => {
	it("has a row for every tool and an entry in the needs map for each", async () => {
		const tools = await listServerTools();
		expect(tools.length).toBeGreaterThan(0);
		const names = tools.map((tool) => tool.name).sort();
		expect(
			Object.keys(TOOL_NEEDS).sort(),
			"TOOL_NEEDS in reference.ts must match tools/list",
		).toEqual(names);
		expect(() => renderToolsTable([{ name: "no_such_tool", inputSchema: {} }])).toThrow(
			/no entry for: no_such_tool/,
		);
	});

	it("shows the table the server's tools/list renders", async () => {
		const expected = renderToolsTable(await listServerTools());
		const actual = readToolsBlock(readFileSync(doc, "utf8"));
		expect(
			actual,
			`The tools table in docs/mcp.md is out of date. Rewrite it with: ${REWRITE_COMMAND}`,
		).toBe(expected);
	});
});
