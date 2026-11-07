import { describe, expect, it } from "vitest";
import { mentionedIds, mentionLink, mentionsAsText, renameMentions } from "../src/mentions";

const maya = { id: "user-1", name: "Maya Chen" };
const gone = { id: "user-1", name: "Deleted member" };
const other = { id: "user-12", name: "Maya Chen" };

describe("what counts as a mention", () => {
	it("starts at the last open bracket before it, as Markdown does", () => {
		const text = `[not a link ${mentionLink(maya)}`;
		expect(mentionedIds(text)).toEqual([maya.id]);
		expect(renameMentions(text, gone)).toBe(`[not a link ${mentionLink(gone)}`);
		expect(mentionsAsText(text)).toBe("[not a link @Maya Chen");
	});

	it("stays on one line", () => {
		expect(mentionedIds("[@Maya\nChen](mention:user-1)")).toEqual([]);
	});

	it("is not one past an id's length", () => {
		expect(mentionedIds(`[@Maya](mention:${"x".repeat(65)})`)).toEqual([]);
	});

	it("keeps an escaped bracket inside its text", () => {
		const link = mentionLink({ id: maya.id, name: "Maya [ops] Chen" });
		expect(mentionsAsText(`Ask ${link}`)).toBe("Ask @Maya [ops] Chen");
		expect(mentionsAsText(`[${link}`)).toBe("[@Maya [ops] Chen");
	});

	it("is renamed behind a backslash too, since the name is there all the same", () => {
		expect(renameMentions(`\\${mentionLink(maya)}`, gone)).toBe(`\\${mentionLink(gone)}`);
		expect(renameMentions(`\\\\${mentionLink(maya)}`, gone)).toBe(`\\\\${mentionLink(gone)}`);
	});
});

describe("mentions in code", () => {
	const inFence = (fence: string, close = fence) =>
		`${fence}\n${mentionLink(maya)}\n${close}\n${mentionLink(other)}`;

	it("tell nobody inside a fence, which runs to one of its own kind at least as long", () => {
		expect(mentionedIds(inFence("```"))).toEqual([other.id]);
		expect(mentionedIds(inFence("~~~"))).toEqual([other.id]);
		expect(mentionedIds(inFence("```", "`````  "))).toEqual([other.id]);
		expect(mentionedIds(inFence("```").replaceAll("\n", "\r\n"))).toEqual([other.id]);
		expect(mentionedIds(inFence("````", "```"))).toEqual([]);
		expect(mentionedIds(inFence("```", "~~~"))).toEqual([]);
		expect(mentionedIds(inFence("```", "``` not a close"))).toEqual([]);
	});

	it("count in a block indented too far to be a fence", () => {
		expect(mentionedIds(`    \`\`\`\n${mentionLink(maya)}`)).toEqual([maya.id]);
	});

	it("tell nobody between runs of backticks just as long", () => {
		expect(mentionedIds(`\`\`${mentionLink(maya)}\`\` ${mentionLink(other)}`)).toEqual([other.id]);
		expect(mentionedIds(`\`${mentionLink(maya)}\`\`\` \``)).toEqual([]);
	});

	it("count when nothing closes the run before them", () => {
		expect(mentionedIds(`so \`\`a ${mentionLink(maya)} \``)).toEqual([maya.id]);
	});
});

describe("text made to be slow", () => {
	// The most a comment or a description can hold, and this runs in a workspace's transaction.
	const LIMIT = 100_000;
	const everyLength = () => {
		let text = "";
		for (let length = 1; text.length < LIMIT; length++) text += `${"`".repeat(length)}x`;
		return text;
	};

	it.each([
		["open brackets", "[".repeat(LIMIT)],
		["escaped brackets", `[${"\\[".repeat(LIMIT / 2)}`],
		["brackets and letters", "[a".repeat(LIMIT / 2)],
		["one long run of backticks", "`".repeat(LIMIT / 2) + "x".repeat(LIMIT / 2)],
		["runs of backticks of every length", everyLength()],
		["fences", "```\n".repeat(LIMIT / 4)],
	])("takes no time over %s", (_, made) => {
		const text = `${made} mention:user-1)`;
		const start = Date.now();
		mentionedIds(text);
		renameMentions(text, gone);
		mentionsAsText(text);
		expect(Date.now() - start).toBeLessThan(1000);
	});
});

describe("renameMentions", () => {
	it("renames every mention of the member, and nobody else's", () => {
		const text = `${mentionLink(maya)} and ${mentionLink(other)} and ${mentionLink(maya)}`;
		expect(renameMentions(text, gone)).toBe(
			`${mentionLink(gone)} and ${mentionLink(other)} and ${mentionLink(gone)}`,
		);
	});

	it("renames a name written with brackets in it", () => {
		const text = mentionLink({ id: maya.id, name: "Maya [ops] Chen" });
		expect(text).toContain("\\[ops\\]");
		expect(renameMentions(text, gone)).toBe(mentionLink(gone));
	});

	it("renames inside code too, where a mention tells nobody but the name is there", () => {
		const text = `\`${mentionLink(maya)}\`\n\n\`\`\`\n${mentionLink(maya)}\n\`\`\``;
		expect(mentionedIds(text)).toEqual([]);
		expect(renameMentions(text, gone)).not.toContain("Maya");
	});

	it("gives back text that is already right, or has no such mention, as it was", () => {
		const done = `Ask ${mentionLink(gone)}`;
		expect(renameMentions(done, gone)).toBe(done);
		const plain = "Maya Chen wrote this, and mention:user-1 is only text";
		expect(renameMentions(plain, gone)).toBe(plain);
	});

	it("still finds the member afterwards", () => {
		expect(mentionedIds(renameMentions(mentionLink(maya), gone))).toEqual([maya.id]);
	});
});
