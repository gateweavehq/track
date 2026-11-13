import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import { freshWorkspace } from "./client";

// `mutateMany` is how the server writes a demo sandbox's sample data and a guided start: many
// mutations in one call, each applied as `mutate` would apply it.

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};

const member: MemberProfile = { ...owner, id: "user-mo", name: "Mo Member", role: "member" };

const team = { name: "team.create", args: { id: "team-eng", key: "ENG", name: "Engineering" } };
const issue = (id: string, title: string) => ({
	name: "issue.create",
	args: { id, teamId: "team-eng", title, sortOrder: `a${id.slice(-1)}` },
});

describe("mutateMany", () => {
	it("applies mutations in order, each one depending on the last", async () => {
		const workspace = freshWorkspace();
		await workspace.syncMember(owner);
		await workspace.syncMember(member);
		const results = await workspace.mutateMany("server", [
			{ member: owner, mutationId: "m-1", body: team },
			{ member: owner, mutationId: "m-2", body: issue("issue-1", "First") },
			{ member, mutationId: "m-3", body: issue("issue-2", "Second") },
		]);
		expect(results.map((result) => result.ok)).toEqual([true, true, true]);
		const versions = results.map((result) => (result.ok ? result.version : 0));
		expect(versions).toEqual([...versions].sort((a, b) => a - b));
		expect(new Set(versions).size).toBe(3);
		expect((await workspace.issue("issue-2"))?.creatorId).toBe(member.id);
	});

	it("stops at the first refusal, whose result comes last", async () => {
		const workspace = freshWorkspace();
		await workspace.syncMember(owner);
		const results = await workspace.mutateMany("server", [
			{ member: owner, mutationId: "m-1", body: team },
			{ member: owner, mutationId: "m-2", body: team },
			{ member: owner, mutationId: "m-3", body: issue("issue-1", "Never made") },
		]);
		expect(results).toHaveLength(2);
		expect(results[1]).toMatchObject({ ok: false });
		expect(await workspace.issue("issue-1")).toBeNull();
	});

	it("applies a mutation id once, as mutate does", async () => {
		const workspace = freshWorkspace();
		await workspace.syncMember(owner);
		const steps = [
			{ member: owner, mutationId: "m-1", body: team },
			{ member: owner, mutationId: "m-2", body: issue("issue-1", "Once") },
		];
		const first = await workspace.mutateMany("server", steps);
		const again = await workspace.mutateMany("server", steps);
		expect(again).toEqual(first);
		expect(await workspace.issues({ teamId: "team-eng", limit: 10 })).toHaveLength(1);
	});
});
