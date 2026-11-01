import { MAX_TEMPLATES_PER_TEAM, type MutationInput } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import { freshWorkspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const bob: MemberProfile = { ...owner, id: "user-bob", name: "Bob", role: "member" };
const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
const TEAM_ID = "team-1";

async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, bob, triage]) await workspace.syncMember(member);
	let n = 0;
	const as = (member: MemberProfile, mutation: MutationInput) =>
		workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
	const ok = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await as(member, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await ok(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	await ok(owner, { name: "label.create", args: { id: "bug", name: "Bug", color: "#e5484d" } });
	await ok(owner, { name: "label.create", args: { id: "ui", name: "UI", color: "#0090ff" } });
	const templates = async () => (await workspace.snapshot(owner)).templates;
	return { workspace, as, ok, templates };
}

describe("issue templates", () => {
	it("are kept by any member, agents included, and reach everyone's replica", async () => {
		const { workspace, ok, templates } = await setup();
		await ok(alice, {
			name: "template.create",
			args: {
				id: "bug-report",
				teamId: TEAM_ID,
				name: "Bug report",
				title: "Bug: ",
				description: "## Steps\n\n## Expected",
				priority: 2,
				labelIds: ["bug", "bug", "ui"],
				assigneeId: bob.id,
			},
		});
		expect((await workspace.snapshot(bob)).templates).toEqual([
			{
				id: "bug-report",
				teamId: TEAM_ID,
				name: "Bug report",
				title: "Bug: ",
				description: "## Steps\n\n## Expected",
				priority: 2,
				// Once each.
				labelIds: ["bug", "ui"],
				assigneeId: bob.id,
				// Only people use it until it is given a schedule.
				repeat: null,
				nextOn: null,
				createdAt: expect.any(Number),
				updatedAt: expect.any(Number),
			},
		]);

		// A title can be left for the person to write, and the rest takes defaults.
		await ok(triage, {
			name: "template.create",
			args: { id: "chore", teamId: TEAM_ID, name: "Chore" },
		});
		expect((await templates()).find((each) => each.id === "chore")).toMatchObject({
			title: "",
			description: null,
			priority: 0,
			labelIds: [],
			assigneeId: null,
		});

		await ok(bob, {
			name: "template.update",
			args: { id: "bug-report", patch: { name: "Bug", priority: 1, labelIds: ["ui"] } },
		});
		expect((await templates()).find((each) => each.id === "bug-report")).toMatchObject({
			name: "Bug",
			priority: 1,
			labelIds: ["ui"],
			title: "Bug: ",
		});

		await ok(alice, { name: "template.delete", args: { id: "chore" } });
		expect((await templates()).map((each) => each.id)).toEqual(["bug-report"]);
		// The MCP tools read them from the directory.
		expect((await workspace.directory()).templates).toMatchObject([{ id: "bug-report" }]);
	});

	it("refuse what an issue could not have, a name the team uses, and more than the limit", async () => {
		const { workspace, as, ok } = await setup();
		const create = (args: Record<string, unknown>) =>
			as(alice, {
				name: "template.create",
				args: { teamId: TEAM_ID, name: "Bug report", ...args },
			} as MutationInput);
		await ok(alice, {
			name: "template.create",
			args: { id: "t-1", teamId: TEAM_ID, name: "Bug report" },
		});

		expect(await create({ id: "t-1", name: "Other" })).toMatchObject({ reason: "invalid" });
		expect(await create({ id: "t-2", name: "BUG REPORT" })).toMatchObject({ reason: "conflict" });
		expect(await create({ id: "t-2", teamId: "nope", name: "Other" })).toMatchObject({
			reason: "not_found",
		});
		expect(await create({ id: "t-2", name: "Other", labelIds: ["nope"] })).toMatchObject({
			reason: "not_found",
		});
		expect(await create({ id: "t-2", name: "Other", assigneeId: "nobody" })).toMatchObject({
			reason: "invalid",
		});
		await workspace.removeMember(bob.id);
		expect(await create({ id: "t-2", name: "Other", assigneeId: bob.id })).toMatchObject({
			reason: "invalid",
		});
		expect(await create({ id: "t-2", name: "Other", priority: 9 })).toMatchObject({
			reason: "invalid",
		});

		await ok(alice, { name: "template.create", args: { id: "t-2", teamId: TEAM_ID, name: "Two" } });
		const update = (patch: Record<string, unknown>, id = "t-2") =>
			as(alice, { name: "template.update", args: { id, patch } } as MutationInput);
		expect(await update({ name: "bug report" })).toMatchObject({ reason: "conflict" });
		// Its own name, in other letters, is free.
		expect(await update({ name: "TWO" })).toMatchObject({ ok: true });
		expect(await update({ labelIds: ["nope"] })).toMatchObject({ reason: "not_found" });
		expect(await update({ priority: 1 }, "nope")).toMatchObject({ reason: "not_found" });
		expect(
			await as(alice, { name: "template.delete", args: { id: "nope" } } as MutationInput),
		).toMatchObject({ reason: "not_found" });

		for (let i = 3; i <= MAX_TEMPLATES_PER_TEAM; i++) {
			await ok(alice, {
				name: "template.create",
				args: { id: `t-${i}`, teamId: TEAM_ID, name: `Template ${i}` },
			});
		}
		expect(await create({ id: "t-over", name: "One too many" })).toMatchObject({
			reason: "invalid",
		});
	});

	it("lose a label when it is deleted, as issues do", async () => {
		const { ok, templates } = await setup();
		await ok(alice, {
			name: "template.create",
			args: { id: "t-1", teamId: TEAM_ID, name: "Bug report", labelIds: ["bug", "ui"] },
		});
		await ok(owner, { name: "label.delete", args: { id: "bug" } });
		expect((await templates())[0]?.labelIds).toEqual(["ui"]);
	});
});
