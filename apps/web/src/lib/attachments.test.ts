import { describe, expect, it } from "vitest";
import {
	attachmentMarkdown,
	attachmentName,
	attachmentPath,
	insertParagraph,
	isAttachmentPath,
	isFileId,
	isInlineType,
} from "./attachments";

describe("attachmentName", () => {
	it("keeps ordinary names as they are", () => {
		expect(attachmentName("Screenshot 2026-10-30 at 14.02.11.png")).toBe(
			"Screenshot 2026-10-30 at 14.02.11.png",
		);
		expect(attachmentName("rapor-şubat.pdf")).toBe("rapor-şubat.pdf");
	});

	it("takes out what is unsafe in a path, a header or a URL", () => {
		expect(attachmentName("../../etc/passwd")).toBe("-..-etc-passwd");
		expect(attachmentName('a"b<c>d|e:f*g?h#i%j\\k.txt')).toBe("a-b-c-d-e-f-g-h-i-j-k.txt");
		expect(attachmentName("line\nbreak\u0000.txt")).toBe("line-break-.txt");
		expect(attachmentName(".env")).toBe("env");
		expect(attachmentName("  spaced   out  .md ")).toBe("spaced out .md");
		expect(attachmentName("")).toBe("file");
		expect(attachmentName("...")).toBe("file");
	});

	it("is stable, so the gateway can check a name by cleaning it again", () => {
		for (const name of ["../x", "a  b", ".hidden", "naïve.txt", "x".repeat(300)]) {
			const once = attachmentName(name);
			expect(attachmentName(once)).toBe(once);
		}
	});

	it("shortens long names and keeps the extension", () => {
		const long = attachmentName(`${"a".repeat(200)}.png`);
		expect([...long]).toHaveLength(100);
		expect(long.endsWith(".png")).toBe(true);
	});

	it("composes accents, so one name has one spelling", () => {
		expect(attachmentName("café.txt")).toBe("café.txt");
	});
});

describe("attachment links", () => {
	const id = "0190f3d6-7c4b-7a10-8f3e-1234567890ab";

	it("recognizes file ids", () => {
		expect(isFileId(id)).toBe(true);
		expect(isFileId("not-an-id")).toBe(false);
		expect(isFileId(id.toUpperCase())).toBe(false);
	});

	it("encodes the name so the path is safe in Markdown", () => {
		const path = attachmentPath("ws-1", id, "plan (final)!.png");
		expect(path).toBe(`/api/files/ws-1/${id}/plan%20%28final%29%21.png`);
		expect(isAttachmentPath(path)).toBe(true);
		expect(isAttachmentPath("https://example.com/api/files/x")).toBe(false);
	});

	it("links images as images and other files as links", () => {
		const path = attachmentPath("ws-1", id, "shot.png");
		expect(attachmentMarkdown("shot.png", path, "image/png")).toBe(`![shot.png](${path})`);
		expect(attachmentMarkdown("[draft].zip", path, "application/zip")).toBe(
			`[\\[draft\\].zip](${path})`,
		);
		// SVG can carry scripts, so it is a download, never an image.
		expect(attachmentMarkdown("logo.svg", path, "image/svg+xml")).toBe(`[logo.svg](${path})`);
		expect(isInlineType("image/svg+xml")).toBe(false);
		expect(isInlineType("text/html")).toBe(false);
	});
});

describe("insertParagraph", () => {
	it("puts the text in a paragraph of its own at the caret", () => {
		expect(insertParagraph("", 0, 0, "![a](/a)")).toEqual({ value: "![a](/a)", caret: 8 });
		expect(insertParagraph("See this", 8, 8, "![a](/a)")).toEqual({
			value: "See this\n\n![a](/a)",
			caret: 18,
		});
		expect(insertParagraph("ab", 1, 1, "x")).toEqual({ value: "a\n\nx\n\nb", caret: 4 });
		expect(insertParagraph("a\n\nb", 2, 2, "x")).toEqual({ value: "a\n\nx\n\nb", caret: 4 });
		expect(insertParagraph("a\n\n", 3, 3, "x")).toEqual({ value: "a\n\nx", caret: 4 });
	});

	it("keeps the text out of a table or list it follows", () => {
		const table = "| a | b |\n| - | - |\n| 1 | 2 |\n";
		expect(insertParagraph(table, table.length, table.length, "x").value).toBe(`${table}\nx`);
	});

	it("replaces the selection", () => {
		expect(insertParagraph("keep drop keep", 5, 9, "x")).toEqual({
			value: "keep \n\nx\n\n keep",
			caret: 8,
		});
	});
});
