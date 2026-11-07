import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { slugProblem } from "./slug";

// What the Worker answers before the router, in `src/server.ts`. The rest of its gateways are
// under /api.
const GATEWAYS = ["api", "mcp", "request"];

/** The first segment of each page's path, from its file's name, which is what names its route. */
function pagePaths(): string[] {
	return readdirSync(resolve(import.meta.dirname, "../routes"))
		.filter((file) => !/^(?:__root|index|\$)/.test(file))
		.map((file) => file.split(".")[0] ?? "");
}

describe("slugProblem", () => {
	it("keeps workspaces off every path the app answers itself", () => {
		const paths = pagePaths();
		expect(paths).toContain("login");
		for (const path of [...paths, ...GATEWAYS]) {
			expect(slugProblem(path), `a workspace at /${path}`).not.toBeNull();
		}
	});

	it("leaves a workspace free to be called what a page used to be", () => {
		expect(slugProblem("account")).toBeNull();
	});
});
