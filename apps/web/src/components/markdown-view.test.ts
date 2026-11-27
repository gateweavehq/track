import { sourceIssueText, sourceLimitNotice, sourceReopenComment } from "@gateweave/track-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attachmentMarkdown } from "#/lib/attachments";
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

	it("plays attached videos inline and leaves other files and outside links as links", () => {
		const video = "/api/files/ws-1/0190f3d6-7c4b-7a10-8f3e-1234567890ab/walkthrough.mp4";
		const typed = render(attachmentMarkdown("walkthrough.mp4", video, "video/mp4"));
		expect(typed).toMatch(/<video[^>]*controls=""[^>]*preload="metadata"/);
		expect(typed).toContain(`src="${video}"`);
		expect(typed).not.toContain('target="_blank"');

		// Links written before the type was kept still play when their name has a video extension.
		expect(render(`[A walkthrough](${video})`)).toContain("<video");

		const text = "/api/files/ws-1/0190f3d6-7c4b-7a10-8f3e-1234567890ab/notes.txt";
		expect(render(`[Notes](${text})`)).not.toContain("<video");
		const outside = render('[Video](https://example.com/walkthrough.mp4 "video/mp4")');
		expect(outside).not.toContain("<video");
		expect(outside).toContain('target="_blank"');
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

it("R12: source reports render URLs, mentions, images and headings only as text", () => {
	const text =
		"# <https://example.com> www.example.com DEV@EXAMPLE.COM [@You](mention:user) ![x](https://img.test/x)";
	const { title, description } = sourceIssueText(
		{
			kind: "alert",
			key: "unsafe",
			state: "open",
			severity: "high",
			sentAt: new Date().toISOString(),
			title: text,
			body: ["~~~~", "~~~", "---", text].join("\n"),
		},
		{ name: text },
	);
	expect(title).toBe(text);
	for (const html of [
		description,
		sourceLimitNotice(text, "ISSUES_PER_DAY").description,
		sourceReopenComment(text),
	].map(render)) {
		expect(html).not.toMatch(/<(?:a|img|h[1-6])\b|data-mention=/);
	}
	expect(render(description)).toContain("<code");
});
