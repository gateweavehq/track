import { describe, expect, it } from "vitest";
import { mentionedIds, mentionLink, renameMentions } from "../src/mentions";

const maya = { id: "user-1", name: "Maya Chen" };
const gone = { id: "user-1", name: "Deleted member" };
const other = { id: "user-12", name: "Maya Chen" };

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
