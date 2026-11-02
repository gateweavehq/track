import { describe, expect, it } from "vitest";
import { cleanText, MALFORMED_TEXT, type MutationInput, mutationSchema } from "../src";

const NUL = "a\0b";
const LONE = "broken \ud83d emoji";
const valid = ["Fix the login 🐛", "修复登录问题", "ログインを直す", "👩🏽‍💻 at work", "Ünïcødé"];

/** Each mutation that carries free text, with the text in `text`. */
const withText = (text: string): MutationInput[] => [
	{ name: "team.create", args: { id: "t", key: "ENG", name: text } },
	{ name: "team.update", args: { id: "t", patch: { name: text } } },
	{
		name: "status.create",
		args: { teamId: "t", key: "review", name: text, category: "started", sortOrder: "a0" },
	},
	{ name: "status.update", args: { teamId: "t", key: "review", patch: { name: text } } },
	{ name: "issue.create", args: { id: "i", teamId: "t", title: text, sortOrder: "a0" } },
	{
		name: "issue.create",
		args: { id: "i", teamId: "t", title: "Title", description: text, sortOrder: "a0" },
	},
	{ name: "issue.update", args: { id: "i", baseVersion: 1, patch: { title: text } } },
	{ name: "issue.update", args: { id: "i", baseVersion: 1, patch: { description: text } } },
	{ name: "issue.decline", args: { id: "i", reply: { id: "c", body: text } } },
	{ name: "label.create", args: { id: "l", name: text, color: "#e5484d" } },
	{ name: "label.update", args: { id: "l", patch: { name: text } } },
	{ name: "project.create", args: { id: "p", name: text } },
	{ name: "project.create", args: { id: "p", name: "Project", description: text } },
	{ name: "project.update", args: { id: "p", patch: { name: text } } },
	{ name: "project.update", args: { id: "p", patch: { description: text } } },
	{
		name: "projectUpdate.create",
		args: { id: "u", projectId: "p", health: "on_track", body: text },
	},
	{ name: "projectUpdate.update", args: { id: "u", patch: { body: text } } },
	{ name: "cycle.update", args: { id: "c", patch: { name: text } } },
	{ name: "comment.create", args: { id: "c", issueId: "i", body: text } },
	{ name: "comment.update", args: { id: "c", body: text } },
	{ name: "view.create", args: { id: "v", name: text, layout: "list", filters: {} } },
	{ name: "view.update", args: { id: "v", patch: { name: text } } },
	{ name: "template.create", args: { id: "tp", teamId: "t", name: text } },
	{ name: "template.create", args: { id: "tp", teamId: "t", name: "Bug", title: text } },
	{ name: "template.create", args: { id: "tp", teamId: "t", name: "Bug", description: text } },
	{ name: "template.update", args: { id: "tp", patch: { name: text } } },
	{ name: "template.update", args: { id: "tp", patch: { title: text } } },
	{ name: "template.update", args: { id: "tp", patch: { description: text } } },
];

describe("user text", () => {
	it("accepts emoji, CJK and other well-formed text in every free-text field", () => {
		for (const text of valid) {
			for (const mutation of withText(text)) {
				const result = mutationSchema.safeParse(mutation);
				expect(result.error, mutation.name).toBeUndefined();
			}
		}
	});

	it("refuses NUL characters and lone surrogates in every free-text field, saying why", () => {
		for (const text of [NUL, "\0", LONE, "\ud800", "\udc00 at the start", "at the end \ud83d"]) {
			for (const mutation of withText(text)) {
				const result = mutationSchema.safeParse(mutation);
				expect(result.success, `${mutation.name} ${JSON.stringify(text)}`).toBe(false);
				expect(result.error?.issues.map((issue) => issue.message)).toContain(MALFORMED_TEXT);
			}
		}
	});

	it("cleans text by dropping NUL and replacing lone surrogates with U+FFFD", () => {
		expect(cleanText(NUL)).toBe("ab");
		expect(cleanText(LONE)).toBe("broken � emoji");
		expect(cleanText("\0\ud800\0")).toBe("�");
		for (const text of valid) expect(cleanText(text)).toBe(text);
	});
});
