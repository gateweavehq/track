import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown-view";

function render(source: string): string {
	return renderToStaticMarkup(createElement(MarkdownView, { source }));
}

describe("MarkdownView", () => {
	it("renders GitHub-flavored Markdown", () => {
		const html = render(
			"# Plan\n\nShip **it** ~~later~~.\n\n- [x] done\n- [ ] next\n\n| a | b |\n| - | - |\n| 1 | 2 |",
		);
		expect(html).toContain("<h1");
		expect(html).toContain("<strong>it</strong>");
		expect(html).toContain("<del>later</del>");
		expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""/);
		expect(html).toContain("<table");
	});

	it("shows HTML in the text as text", () => {
		const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	it("drops links that would run code", () => {
		for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>"]) {
			const html = render(`[click](${href})`);
			expect(html).not.toMatch(/href="(javascript|data):/i);
		}
		expect(render("[x](vbscript:msgbox)")).not.toContain("vbscript");
	});

	it("opens other sites in a new tab, and the app's own pages in place", () => {
		expect(render("[site](https://example.com)")).toContain(
			'href="https://example.com" target="_blank" rel="noopener noreferrer nofollow"',
		);
		expect(render("[other](//example.com/x)")).toContain('target="_blank"');
		expect(render("[issue](/acme/issue/ENG-1)")).not.toContain("target=");
	});

	it("shows only attached files as images", () => {
		const attached = "/api/files/ws-1/0190f3d6-7c4b-7a10-8f3e-1234567890ab/shot.png";
		const html = render(`![A screenshot](${attached})`);
		expect(html).toContain(`<img src="${attached}" alt="A screenshot"`);

		// Loading an image from elsewhere would tell its host who read the issue.
		const tracker = render("![pixel](https://tracker.example/p.gif)");
		expect(tracker).not.toContain("<img");
		expect(tracker).toContain('href="https://tracker.example/p.gif"');
		expect(tracker).toContain(">pixel</a>");
	});

	it("shows mentions under members' current names, and as written for anyone else", () => {
		const members = new Map([["u-1", { name: "Maya Chen" }]]);
		const html = renderToStaticMarkup(
			createElement(MarkdownView, {
				source: "Ask [@Maya](mention:u-1) or [@Former](mention:u-gone)",
				members,
			}),
		);
		expect(html).toContain('<span data-mention="u-1"');
		expect(html).toContain(">@Maya Chen</span>");
		expect(html).toContain(">@Former</span>");
		expect(html).not.toContain("<a");
		expect(html).not.toContain("mention:");
	});
});
