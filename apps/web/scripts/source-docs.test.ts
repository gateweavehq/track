import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("R53: both architecture references describe event admission and ordered removal", () => {
	for (const path of ["AGENTS.md", "docs/architecture.md"]) {
		const document = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
		const section = document.slice(document.indexOf("POST /api/events")).replace(/\s+/g, " ");
		expect(section.slice(0, 550)).toMatch(/bearer key.*D1/i);
		expect(section.slice(0, 550)).toMatch(/active source|source exists and is active/);
		expect(section.slice(0, 1250)).toMatch(
			/seals the source so a key made during removal cannot write, deletes its (?:D1 keys|keys in D1), then removes (?:its|the) signals and source/,
		);
	}
});
