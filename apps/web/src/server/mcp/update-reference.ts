// Rewrites the tools table in docs/mcp.md from the server's own tools/list: `pnpm docs:mcp`.
import { readFileSync, writeFileSync } from "node:fs";
import { listServerTools, renderToolsTable, replaceToolsBlock } from "./reference";

const path = new URL("../../../../../docs/mcp.md", import.meta.url);
const table = renderToolsTable(await listServerTools());
const before = readFileSync(path, "utf8");
const after = replaceToolsBlock(before, table);
if (after === before) {
	console.log("docs/mcp.md is already up to date.");
} else {
	writeFileSync(path, after);
	console.log("Rewrote the tools table in docs/mcp.md.");
}
