import type { Comment, Issue, Team } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { excerpt, normalize, search, tokenize } from "./search";

function issue(overrides: Partial<Issue>): Issue {
	return {
		id: "i1",
		teamId: "t1",
		number: 1,
		title: "Title",
		description: null,
		status: "backlog",
		priority: 0,
		assigneeId: null,
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		creatorId: "user",
		sortOrder: "a0",
		version: 1,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function comment(overrides: Partial<Comment>): Comment {
	return {
		id: "c1",
		issueId: "i1",
		authorId: "user",
		body: "",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const team: Team = {
	id: "t1",
	key: "ENG",
	name: "Engineering",
	cycles: null,
	createdAt: 0,
	updatedAt: 0,
};

function tables(issues: Issue[], comments: Comment[] = []) {
	return {
		teams: new Map([[team.id, team]]),
		issues: new Map(issues.map((row) => [row.id, row])),
		comments: new Map(comments.map((row) => [row.id, row])),
	};
}

function ids(issues: Issue[], query: string, comments: Comment[] = []) {
	return search(tables(issues, comments), query).map((result) => result.issue.id);
}

describe("normalize and tokenize", () => {
	it("folds diacritics and case", () => {
		expect(normalize("Résumé")).toBe("resume");
		expect(normalize("İstanbul")).toBe("istanbul");
		expect(normalize("ÇAĞRI")).toBe("cagri");
	});

	it("splits on anything but letters and digits", () => {
		expect(tokenize("ENG-12: fix the log-in (v2)")).toEqual([
			"eng",
			"12",
			"fix",
			"the",
			"log",
			"in",
			"v2",
		]);
		expect(tokenize("   ")).toEqual([]);
	});
});

describe("matching", () => {
	it("ignores diacritics in both directions", () => {
		const rows = [
			issue({ id: "a", title: "Update résumé parser" }),
			issue({ id: "b", title: "İstanbul office" }),
		];
		expect(ids(rows, "resume")).toEqual(["a"]);
		expect(ids(rows, "RÉSUMÉ")).toEqual(["a"]);
		expect(ids(rows, "istanbul")).toEqual(["b"]);
		expect(ids(rows, "İSTANBUL")).toEqual(["b"]);
	});

	it("matches the dotless ı only as itself", () => {
		const rows = [issue({ title: "kırmızı" })];
		expect(ids(rows, "kırmızı")).toEqual(["i1"]);
		// ı has no decomposition, so it is not folded into i.
		expect(ids(rows, "kirmizi")).toEqual([]);
	});

	it("matches token prefixes, not substrings", () => {
		const rows = [issue({ title: "Fix authentication flow" })];
		expect(ids(rows, "auth")).toEqual(["i1"]);
		expect(ids(rows, "thentication")).toEqual([]);
	});

	it("requires every query token to match, in any field", () => {
		const rows = [
			issue({ id: "a", title: "Login bug", description: "Crashes on safari" }),
			issue({ id: "b", title: "Login page" }),
		];
		expect(ids(rows, "login safari")).toEqual(["a"]);
		expect(ids(rows, "login nothing")).toEqual([]);
	});

	it("matches nothing for a query without tokens", () => {
		const rows = [issue({ title: "Anything" })];
		expect(ids(rows, "")).toEqual([]);
		expect(ids(rows, " - ! ")).toEqual([]);
	});

	it("matches the issue key and its number", () => {
		const rows = [
			issue({ id: "a", number: 12, title: "x" }),
			issue({ id: "b", number: 7, title: "y" }),
		];
		expect(ids(rows, "eng-12")).toEqual(["a"]);
		expect(ids(rows, "ENG 12")).toEqual(["a"]);
		expect(ids(rows, "12")).toEqual(["a"]);
		expect(ids(rows, "eng").sort()).toEqual(["a", "b"]);
	});

	it("searches description and comments", () => {
		const rows = [
			issue({ id: "a", title: "One", description: "mentions zebra" }),
			issue({ id: "b", title: "Two" }),
		];
		const notes = [comment({ issueId: "b", body: "we saw a zebra crossing" })];
		expect(ids(rows, "zebra", notes).sort()).toEqual(["a", "b"]);
	});

	it("stops matching a comment once it is gone from the map", () => {
		const rows = [issue({ title: "Two" })];
		const note = comment({ issueId: "i1", body: "needle" });
		expect(ids(rows, "needle", [note])).toEqual(["i1"]);
		expect(ids(rows, "needle", [])).toEqual([]);
	});

	it("respects the limit", () => {
		const rows = Array.from({ length: 30 }, (_, index) => issue({ id: `i${index}`, title: "bug" }));
		expect(search(tables(rows), "bug")).toHaveLength(20);
		expect(search(tables(rows), "bug", 3)).toHaveLength(3);
	});
});

describe("ranking", () => {
	it("puts title before description before comments", () => {
		const rows = [
			issue({ id: "comment", title: "A" }),
			issue({ id: "description", title: "B", description: "kiwi" }),
			issue({ id: "title", title: "kiwi" }),
		];
		const notes = [comment({ issueId: "comment", body: "kiwi" })];
		expect(ids(rows, "kiwi", notes)).toEqual(["title", "description", "comment"]);
	});

	it("scores each token by its best field and sums them", () => {
		const rows = [
			issue({ id: "both", title: "alpha", description: "beta" }),
			issue({ id: "one", title: "alpha beta" }),
		];
		const results = search(tables(rows), "alpha beta");
		expect(results.map((result) => [result.issue.id, result.score])).toEqual([
			["one", 20],
			["both", 13],
		]);
	});

	it("puts the issue whose key was typed in full first", () => {
		const rows = [
			issue({ id: "exact", number: 12, title: "x", updatedAt: 1 }),
			issue({ id: "longer", number: 120, title: "y", updatedAt: 9 }),
			issue({ id: "titled", number: 3, title: "12 tips", updatedAt: 9 }),
		];
		expect(ids(rows, "ENG-12")[0]).toBe("exact");
		expect(ids(rows, "12")[0]).toBe("exact");
		expect(ids(rows, "eng")[0]).not.toBe("exact");
	});

	it("breaks ties by recency", () => {
		const rows = [
			issue({ id: "old", title: "bug", updatedAt: 1 }),
			issue({ id: "new", title: "bug", updatedAt: 9 }),
			issue({ id: "mid", title: "bug", updatedAt: 5 }),
		];
		expect(ids(rows, "bug")).toEqual(["new", "mid", "old"]);
	});
});

describe("snippets", () => {
	const long =
		"The nightly export job stalls when the warehouse connection drops for longer than a minute, and nobody notices until morning.";

	it("has none when the title matches", () => {
		const [result] = search(
			tables([issue({ title: "export", description: "export again" })]),
			"export",
		);
		expect(result?.snippet).toBeUndefined();
	});

	it("excerpts the description around the match", () => {
		const [result] = search(tables([issue({ description: long })]), "warehouse");
		const snippet = result?.snippet ?? "";
		expect(snippet).toContain("warehouse");
		expect(snippet.length).toBeLessThanOrEqual(84);
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
	});

	it("cuts only at word boundaries", () => {
		const snippet = excerpt(long, "warehouse") ?? "";
		const inner = snippet.replace(/^…/, "").replace(/…$/, "");
		for (const word of inner.split(" "))
			expect(long.split(/[ ,]+/)).toContain(word.replace(/,$/, ""));
	});

	it("uses the whole text when it is short", () => {
		expect(excerpt("short   text\nhere", "text")).toBe("short text here");
	});

	it("excerpts a comment when only a comment matches", () => {
		const notes = [comment({ issueId: "i1", body: "Seen again on staging" })];
		const [result] = search(tables([issue({ title: "Plain" })], notes), "staging");
		expect(result?.snippet).toBe("Seen again on staging");
	});

	it("matches words with diacritics in the original text", () => {
		expect(excerpt("Send the résumé today", "resume")).toBe("Send the résumé today");
	});
});

describe("caches", () => {
	it("stay correct when a row is replaced with a new object", () => {
		const before = issue({ title: "apple" });
		expect(ids([before], "apple")).toEqual(["i1"]);
		const after = { ...before, title: "banana", description: "apple" };
		const result = search(tables([after]), "apple")[0];
		expect(result?.score).toBe(3);
		expect(ids([after], "banana")).toEqual(["i1"]);
		// The old row still answers as before.
		expect(ids([before], "banana")).toEqual([]);
	});

	it("regroup comments when the map is replaced", () => {
		const rows = [issue({ title: "Plain" })];
		const first = tables(rows, [comment({ body: "alpha" })]);
		expect(search(first, "alpha")).toHaveLength(1);
		expect(search({ ...first, comments: new Map() }, "alpha")).toHaveLength(0);
		const edited = new Map([["c1", comment({ body: "omega" })]]);
		expect(search({ ...first, comments: edited }, "alpha")).toHaveLength(0);
		expect(search({ ...first, comments: edited }, "omega")).toHaveLength(1);
	});
});
