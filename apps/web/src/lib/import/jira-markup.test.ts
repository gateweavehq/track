import { describe, expect, it } from "vitest";
import { jiraToMarkdown } from "./jira-markup";

describe("jiraToMarkdown", () => {
	it("turns headings, lists, quotes and rules into Markdown", () => {
		expect(
			jiraToMarkdown(
				[
					"h2. Steps",
					"# open the cart",
					"## pick a card",
					"# pay",
					"",
					"* Safari 18",
					"** on iOS",
					"bq. It worked last week.",
					"----",
				].join("\n"),
			),
		).toBe(
			[
				"## Steps",
				"1. open the cart",
				"   1. pick a card",
				"1. pay",
				"",
				"- Safari 18",
				"   - on iOS",
				"> It worked last week.",
				"---",
			].join("\n"),
		);
	});

	it("turns inline markup into Markdown, and leaves monospace as it is", () => {
		expect(
			jiraToMarkdown(
				"*Bold* and _italic_ and -gone- and +under+, with {{a *literal* -x-}} and ??a cite??",
			),
		).toBe("**Bold** and _italic_ and ~~gone~~ and under, with `a *literal* -x-` and _a cite_");
		// Markup characters inside words and numbers are text.
		expect(jiraToMarkdown("2*3*4 is 24, a well-known-fact, 2026-11-02, -5 to +5")).toBe(
			"2*3*4 is 24, a well-known-fact, 2026-11-02, -5 to +5",
		);
	});

	it("keeps code blocks as they are, with their language", () => {
		expect(
			jiraToMarkdown(
				[
					"Before:",
					"{code:java}",
					"if (a * b > 0) { *x* = -y-; }",
					"h1. not a heading",
					"{code}",
					"{noformat}plain *text*{noformat}",
					"{code:title=Run.sh|borderStyle=solid}",
					"echo hi",
					"{code}",
				].join("\n"),
			),
		).toBe(
			[
				"Before:",
				"```java",
				"if (a * b > 0) { *x* = -y-; }",
				"h1. not a heading",
				"```",
				"```",
				"plain *text*",
				"```",
				"```",
				"echo hi",
				"```",
			].join("\n"),
		);
		// A block left open is closed at the end.
		expect(jiraToMarkdown("{code}\nx")).toBe("```\nx\n```");
	});

	it("turns links, mentions and attachments into Markdown or text", () => {
		expect(
			jiraToMarkdown(
				"See [the docs|https://example.test/docs], [https://example.test], [SHOP-12|SHOP-12], [~ada] and [~accountid:5b10ac8d82e05b22cc7d4ef5]. !screenshot.png|thumbnail! !https://example.test/a.png!",
			),
		).toBe(
			"See [the docs](https://example.test/docs), <https://example.test>, SHOP-12, @ada and @someone. _(attachment in Jira: screenshot.png)_ ![](https://example.test/a.png)",
		);
	});

	it("does not make links of other schemes", () => {
		expect(jiraToMarkdown("[click|javascript:alert(1)]")).toBe("click");
	});

	it("turns tables into Markdown tables, with a header row", () => {
		expect(jiraToMarkdown("||Browser||Works||\n|Safari|*no*|\n|Firefox|yes|")).toBe(
			"| Browser | Works |\n| --- | --- |\n| Safari | **no** |\n| Firefox | yes |",
		);
		expect(jiraToMarkdown("|a|b|")).toBe("|   |   |\n| --- | --- |\n| a | b |");
		// A backslash ending a cell would escape the pipe after it, and join two cells.
		expect(jiraToMarkdown("||Path||Size||\n|C:\\temp\\|2|")).toBe(
			"| Path | Size |\n| --- | --- |\n| C:\\\\temp\\\\ | 2 |",
		);
	});

	it("quotes what {quote} holds, and drops colors and panels around text", () => {
		expect(
			jiraToMarkdown(
				"{quote}\nfirst line\nsecond line\n{quote}\n{panel:title=Note}\n{color:red}red{color} text\n{panel}",
			),
		).toBe("> first line\n> second line\nred text");
	});
});
