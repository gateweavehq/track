import { expect, it } from "vitest";
import { matchExpression } from "../src/search";

it("bounds dotless-i alternatives across a long query while requiring every word", () => {
	const expression = matchExpression(Array(22).fill("aiiiiiii").join(" "));
	expect(expression).toBeDefined();
	if (!expression) return;
	expect(expression.split(" AND ")).toHaveLength(22);
	expect((expression.match(/"\*/g) ?? []).length).toBeLessThanOrEqual(64);
	expect(expression.match(/ OR /g)?.length ?? 0).toBeLessThanOrEqual(64);
	expect(expression.length).toBeLessThan(1_500);
	expect(expression.split(" AND ").at(-1)).toBe('"aiiiiiii"*');
});

it("keeps Turkish spellings in both directions", () => {
	for (const word of ["ışık", "isik"]) {
		const expression = matchExpression(word);
		expect(expression).toContain('"isik"*');
		expect(expression).toContain('"ısık"*');
		expect(expression).toContain('"isık"*');
	}
});

it("keeps the spelling as typed when the dotless-i alternatives reach their cap", () => {
	// Nine i positions: only the first four vary, so the typed form must be kept on its own.
	expect(matchExpression("iiiiiiiiı")).toContain('"iiiiiiiiı"*');
	const crowded = matchExpression(Array(22).fill("aiiiiiiı").join(" "));
	expect(crowded).toBeDefined();
	for (const group of crowded?.split(" AND ") ?? []) expect(group).toContain('"aiiiiiiı"*');
	expect((crowded?.match(/"\*/g) ?? []).length).toBeLessThanOrEqual(64);
});
