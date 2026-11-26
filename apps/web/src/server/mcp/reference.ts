import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createTrackServer } from "./tools";

/**
 * The tools table of `docs/mcp.md`, rendered from what the server itself lists. The page between
 * these two markers is never typed by hand: `reference.test.ts` fails when it differs, and
 * `pnpm docs:mcp` rewrites it.
 */
export const TOOLS_START = "<!-- mcp-tools:start -->";
export const TOOLS_END = "<!-- mcp-tools:end -->";
export const REWRITE_COMMAND = "pnpm docs:mcp";

/**
 * What each tool needs of the caller, by tool name. The server enforces these; the descriptions
 * and the role checks in `tools.ts` are the source, so a new tool needs an entry here and the
 * reference test fails until it has one. Every tool needs the `track` scope.
 */
export const TOOL_NEEDS: Record<string, string> = {
	add_comment: "`track`; member",
	attach_file: "`track`; member",
	create_issue: "`track`; member",
	create_label: "`track`; member",
	create_project: "`track`; human workspace member (not an agent)",
	create_team: "`track`; workspace admin rights (an owner or an admin)",
	get_insights: "`track`; member",
	get_issue: "`track`; member",
	get_panel:
		"`track`; while the panel is open, a seat of it or a workspace owner or admin; once it is revealed, any member",
	get_workspace: "`track`; member",
	link_issues: "`track`; member",
	list_project_updates: "`track`; member",
	list_workspaces: "`track`",
	open_panel: "`track`; owner or admin",
	post_project_update: "`track`; member",
	search_issues: "`track`; member",
	submit_position: "`track`; a seat of the panel",
	triage_request: "`track`; member",
	unlink_issues: "`track`; member",
	update_comment: "`track`; member",
	update_issue: "`track`; member",
	update_project: "`track`; human workspace member (not an agent)",
};

/** The parts of a listed tool the table uses. */
export interface ListedTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown> & { required?: string[] };
	outputSchema?: Record<string, unknown>;
}

/** Lists the server's tools the way any client does: through an MCP client over HTTP. */
export async function listServerTools(): Promise<ListedTool[]> {
	const handler = createMcpHandler(() =>
		createTrackServer({
			origin: "https://track.example.com",
			workspaces: async () => [],
			workspace: async () => null,
		}),
	);
	const client = new Client({ name: "mcp-reference", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://track.example.com/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	try {
		return (await client.listTools()).tools;
	} finally {
		await client.close();
	}
}

/** The property names of a JSON Schema object. */
function propertiesOf(schema: Record<string, unknown> | undefined): Record<string, unknown> {
	const properties = schema?.properties;
	return typeof properties === "object" && properties !== null
		? (properties as Record<string, unknown>)
		: {};
}

/** The first sentence of a description. */
function firstSentence(description: string) {
	const text = description.replace(/\s+/g, " ").trim();
	return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

function cell(text: string) {
	return text.replaceAll("|", "\\|");
}

function code(names: string[]) {
	return names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", ");
}

/** Renders one row per tool, sorted by name, as a Markdown table. */
export function renderToolsTable(tools: ListedTool[]): string {
	const missing = tools.filter((tool) => TOOL_NEEDS[tool.name] === undefined);
	if (missing.length > 0) {
		throw new Error(
			`TOOL_NEEDS in apps/web/src/server/mcp/reference.ts has no entry for: ${missing.map((tool) => tool.name).join(", ")}`,
		);
	}
	const rows = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			const required = new Set(tool.inputSchema.required ?? []);
			const input = Object.keys(propertiesOf(tool.inputSchema)).map(
				(property) => `\`${property}\`${required.has(property) ? "" : "?"}`,
			);
			const output = Object.keys(propertiesOf(tool.outputSchema));
			return [
				`\`${tool.name}\``,
				firstSentence(tool.description ?? ""),
				input.length === 0 ? "none" : input.join(", "),
				code(output),
				TOOL_NEEDS[tool.name] ?? "",
			].map(cell);
		});
	return aligned([["Tool", "What it does", "Input", "Output", "Needs"], ...rows]);
}

/**
 * A Markdown table with its columns padded, the way Biome formats one, so that `pnpm check` and
 * `pnpm docs:mcp` agree on every character of it.
 */
function aligned(rows: string[][]): string {
	const widths = (rows[0] ?? []).map((_, column) =>
		Math.max(3, ...rows.map((row) => row[column]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		`| ${cells.map((value, column) => value.padEnd(widths[column] ?? 0)).join(" | ")} |`;
	const [header, ...body] = rows;
	return [
		line(header ?? []),
		line(widths.map((width) => "-".repeat(width))),
		...body.map(line),
	].join("\n");
}

/** The text of `document` between the markers, without the blank lines around it. */
export function readToolsBlock(document: string): string | null {
	const start = document.indexOf(TOOLS_START);
	const end = document.indexOf(TOOLS_END);
	if (start === -1 || end === -1 || end < start) return null;
	return document.slice(start + TOOLS_START.length, end).trim();
}

/** `document` with the block between the markers replaced by `table`. */
export function replaceToolsBlock(document: string, table: string): string {
	const start = document.indexOf(TOOLS_START);
	const end = document.indexOf(TOOLS_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`docs/mcp.md needs ${TOOLS_START} and ${TOOLS_END} around the tools table.`);
	}
	return `${document.slice(0, start + TOOLS_START.length)}\n\n${table}\n\n${document.slice(end)}`;
}
