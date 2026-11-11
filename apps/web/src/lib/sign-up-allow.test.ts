import { describe, expect, it } from "vitest";
import { allowEntry, allowNote, isDomainEntry, MAX_ALLOW_NOTE } from "./sign-up-allow";

describe("allowEntry", () => {
	it("keeps an address trimmed and lowercased", () => {
		expect(allowEntry.parse("  Ada@Example.COM ")).toBe("ada@example.com");
	});

	it("keeps a domain with its @, trimmed and lowercased", () => {
		expect(allowEntry.parse(" @Example.com ")).toBe("@example.com");
		expect(isDomainEntry("@example.com")).toBe(true);
		expect(isDomainEntry("ada@example.com")).toBe(false);
	});

	it.each([
		"",
		"@",
		"ada",
		"@localhost",
		"@example",
		"ada@example",
		"@sub..example.com",
		"@-example.com",
		"@example.com/path",
		"@ada@example.com",
		"ada@@example.com",
		"two words@example.com",
		"@exa mple.com",
		`@${"a".repeat(250)}.com`,
	])("refuses %j", (entry) => {
		expect(allowEntry.safeParse(entry).success).toBe(false);
	});
});

describe("allowNote", () => {
	it("trims, and takes an empty note as none", () => {
		expect(allowNote.parse("  from the waitlist ")).toBe("from the waitlist");
		expect(allowNote.parse("   ")).toBeNull();
	});

	it("takes at most 200 characters", () => {
		expect(allowNote.safeParse("x".repeat(MAX_ALLOW_NOTE)).success).toBe(true);
		expect(allowNote.safeParse("x".repeat(MAX_ALLOW_NOTE + 1)).success).toBe(false);
	});
});
