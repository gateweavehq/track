import {
	type MemberRole,
	mentionedIds,
	mentionLink,
	mentionsAsText,
	newMentions,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { insertMention, mentionCandidates, mentionQuery } from "./mentions";

const member = (id: string, name: string, email: string, role: MemberRole = "member") => ({
	id,
	name,
	email,
	role,
});
const maya = member("u-maya", "Maya Chen", "maya@example.com");
const sam = member("u-sam", "Sam Österberg", "sam@example.com", "admin");
const lena = member("u-lena", "Lena Müller", "lena@example.com");
const bot = member("u-bot", "Mentor Bot", "bot@example.com", "agent");

describe("mentions in Markdown", () => {
	it("are links to members, found once each and never in code", () => {
		const link = mentionLink({ id: "u-1", name: "Maya [Ops]  Chen" });
		expect(link).toBe("[@Maya \\[Ops\\] Chen](mention:u-1)");
		const text = `${link} and [@Sam](mention:u-2), ${link}\n\n\`[@Code](mention:u-3)\`\n\n\`\`\`\n[@Fenced](mention:u-4)\n\`\`\``;
		expect(mentionedIds(text)).toEqual(["u-1", "u-2"]);
		expect(mentionedIds("[@Site](https://example.com/mention:u-5)")).toEqual([]);
		expect(newMentions("[@Sam](mention:u-2)", text)).toEqual(["u-1"]);
		expect(newMentions(null, null)).toEqual([]);
	});

	it("read as names in plain text, current ones when known", () => {
		const text = "Ask [@Maya \\[Ops\\]](mention:u-1) or [@Sam](mention:u-2)";
		expect(mentionsAsText(text)).toBe("Ask @Maya [Ops] or @Sam");
		expect(mentionsAsText(text, (id) => (id === "u-2" ? "Samuel" : undefined))).toBe(
			"Ask @Maya [Ops] or @Samuel",
		);
	});
});

describe("typing a mention", () => {
	it("starts at an @ that begins a word", () => {
		expect(mentionQuery("Hi @ma", 6)).toEqual({ start: 3, query: "ma" });
		expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionQuery("(@maya chen", 11)).toEqual({ start: 1, query: "maya chen" });
		expect(mentionQuery("mail me@example", 15)).toBeNull();
		expect(mentionQuery("@maya chen is", 13)).toBeNull();
		expect(mentionQuery("Hi @ma and more", 6)).toEqual({ start: 3, query: "ma" });
	});

	it("finds people by any word of their name or their email, then agents", () => {
		const all = [bot, lena, maya, sam];
		expect(mentionCandidates(all, "")).toEqual([lena, maya, sam, bot]);
		expect(mentionCandidates(all, "m")).toEqual([lena, maya, bot]);
		expect(mentionCandidates(all, "chen")).toEqual([maya]);
		expect(mentionCandidates(all, "sam ost")).toEqual([sam]);
		expect(mentionCandidates(all, "MULLER")).toEqual([lena]);
		expect(mentionCandidates(all, "lena@")).toEqual([lena]);
		expect(mentionCandidates(all, "zed")).toEqual([]);
		expect(mentionCandidates(all, "", 2)).toEqual([lena, maya]);
	});

	it("puts the mention in place of what was typed, with a space after it", () => {
		expect(insertMention("Hi @ma", 3, 6, maya)).toEqual({
			value: "Hi [@Maya Chen](mention:u-maya) ",
			caret: 32,
		});
		expect(insertMention("Hi @ma there", 3, 6, maya)).toEqual({
			value: "Hi [@Maya Chen](mention:u-maya) there",
			caret: 32,
		});
	});
});
