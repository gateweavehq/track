import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { INTAKE_EMAIL_ACTOR_ID, type MutationInput, privateId } from "@gateweave/track-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	LINK_HEADER,
	MEMBER_HEADER,
	type MemberProfile,
	type RequesterNotice,
	SESSION_HEADER,
	type WorkspaceDO,
	type WorkspaceLink,
} from "../src";
import { freshWorkspace, SESSION, type Workspace } from "./client";

// What people hear of a decision on a request (TRK-41): the members who follow it, in their
// inbox, and whoever filed it through a form or by email, by email.

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const TEAM_ID = "team-1";
const LINK: WorkspaceLink = { id: "ws-1", slug: "acme", origin: "https://track.example.com" };

async function setup({ link = true } = {}) {
	const workspace = freshWorkspace();
	for (const member of [owner, alice]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	await as(owner, { name: "team.update", args: { id: TEAM_ID, patch: { intakeForm: true } } });
	// These are about who follows a request. Following the intake has its own tests.
	await as(owner, { name: "team.followIntake", args: { teamId: TEAM_ID, following: false } });
	if (link) {
		await workspace.syncMember(owner);
		const response = await workspace.fetch("https://workspace/socket", {
			headers: {
				Upgrade: "websocket",
				[MEMBER_HEADER]: owner.id,
				[LINK_HEADER]: JSON.stringify(LINK),
				[SESSION_HEADER]: JSON.stringify(SESSION),
			},
		});
		response.webSocket?.accept();
		response.webSocket?.close(1000);
	}

	const sent: RequesterNotice[] = [];
	await runInDurableObject(workspace, (instance: WorkspaceDO) => {
		const hook = instance as unknown as {
			sendRequesterNotice(notice: RequesterNotice): Promise<void>;
		};
		vi.spyOn(hook, "sendRequesterNotice").mockImplementation(async (notice) => {
			sent.push(notice);
		});
	});

	const formKey = (await workspace.snapshot(owner)).teams[0]?.intakeFormKey;
	if (!formKey) throw new Error("No form");
	/** Files a request through the form, as someone who left this address, or none. */
	const file = async (title: string, requester: string | null) => {
		expect(
			await workspace.fileRequest({
				via: "form",
				key: formKey,
				title,
				description: null,
				sortOrder: "a5",
				requester: requester && { workspaceId: "ws-1", email: requester },
			}),
		).toBe(true);
		const issue = (await workspace.snapshot(owner)).issues.find((each) => each.title === title);
		if (!issue) throw new Error("Not filed");
		return issue;
	};
	return { workspace, as, file, sent };
}

/**
 * Runs the alarm, which emails decisions, and waits for it to finish. A decision wakes the alarm
 * on its own, so a run may already be under way, in which case there is none to start: then this
 * waits for that run, which schedules the next one ahead of now when it ends.
 */
async function runAlarm(workspace: Workspace) {
	await runDurableObjectAlarm(workspace);
	await vi.waitFor(async () => {
		const alarm = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThan(Date.now());
	});
}

describe("deciding on a request", () => {
	it("tells whoever filed it through a form what the team decided, once", async () => {
		const { workspace, as, file, sent } = await setup();
		const wanted = await file("Export to PDF", "sam@customer.test");
		const unwanted = await file("Dark mode", "lee@customer.test");
		const anonymous = await file("No address", null);

		await as(alice, { name: "issue.accept", args: { id: wanted.id } });
		await as(alice, {
			name: "issue.decline",
			args: {
				id: unwanted.id,
				reply: {
					id: "comment-1",
					body: "Not this year, [@Olivia Owner](mention:user-owner) says.",
				},
			},
		});
		await as(alice, { name: "issue.accept", args: { id: anonymous.id } });
		await runAlarm(workspace);

		expect(sent).toHaveLength(2);
		expect(sent).toEqual(
			expect.arrayContaining([
				{
					workspaceId: "ws-1",
					email: "sam@customer.test",
					accepted: true,
					reply: null,
					request: { title: "Export to PDF" },
					team: "Engineering",
					replyKey: expect.stringMatching(/^[a-z2-7]{26}$/),
				},
				expect.objectContaining({
					email: "lee@customer.test",
					accepted: false,
					reply: "Not this year, [@Olivia Owner](mention:user-owner) says.",
				}),
			]),
		);

		// Told once: another run sends nothing more.
		await runAlarm(workspace);
		expect(sent).toHaveLength(2);
	});

	it("tells nobody of a deleted request", async () => {
		const { workspace, as, file, sent } = await setup();
		const request = await file("Gone", "sam@customer.test");
		await as(owner, { name: "issue.delete", args: { id: request.id } });
		await runAlarm(workspace);
		expect(sent).toEqual([]);
	});

	it("tells the requester though no member's browser ever connected", async () => {
		const { workspace, as, file, sent } = await setup({ link: false });
		const request = await file("Unlinked", "sam@customer.test");
		await as(owner, { name: "issue.accept", args: { id: request.id } });
		await runAlarm(workspace);
		expect(sent).toEqual([expect.objectContaining({ workspaceId: "ws-1", accepted: true })]);
	});

	it("puts the decision in the inbox of the members who follow the request", async () => {
		const { workspace, as, sent } = await setup();
		// Alice files them herself, so she follows them.
		for (const id of ["issue-1", "issue-2"]) {
			await as(alice, {
				name: "issue.create",
				args: { id, teamId: TEAM_ID, title: id, sortOrder: "a0", intake: true },
			});
		}
		await as(owner, { name: "issue.accept", args: { id: "issue-1" } });
		await as(owner, { name: "issue.decline", args: { id: "issue-2" } });

		const inbox = (await workspace.snapshot(alice)).inbox;
		expect(inbox.find((item) => item.id === privateId("issue-1", alice.id))).toMatchObject({
			event: { type: "intake", accepted: true },
			actorId: owner.id,
			unread: 1,
		});
		// Said as a decline, not as a move to Canceled.
		expect(inbox.find((item) => item.id === privateId("issue-2", alice.id))).toMatchObject({
			event: { type: "intake", accepted: false },
			unread: 1,
		});
		// Filed by a member, they have no requester to email.
		await runAlarm(workspace);
		expect(sent).toEqual([]);
	});

	it("leaves the inbox alone for a decline that a change to the workflow makes", async () => {
		const { workspace, as } = await setup();
		await as(alice, {
			name: "issue.create",
			args: { id: "issue-1", teamId: TEAM_ID, title: "Request", sortOrder: "a0", intake: true },
		});
		await as(owner, {
			name: "status.update",
			args: { teamId: TEAM_ID, key: "backlog", patch: { category: "canceled" } },
		});
		const inbox = (await workspace.snapshot(alice)).inbox;
		expect(inbox.find((item) => item.issueId === "issue-1")).toBeUndefined();
	});
});

// A requester's reply to the decision email becomes a comment on their request (TRK-55).
describe("replying to a decision", () => {
	async function decided() {
		const { workspace, as, file, sent } = await setup();
		const request = await file("Export to PDF", "sam@customer.test");
		await as(alice, { name: "issue.subscribe", args: { issueId: request.id, subscribed: true } });
		await as(owner, { name: "issue.accept", args: { id: request.id } });
		await runAlarm(workspace);
		const key = sent[0]?.replyKey;
		if (!key) throw new Error("No decision sent");
		return { workspace, as, request, key, sent };
	}

	it("files the requester's reply as a comment by Email, and tells those who follow it", async () => {
		const { workspace, request, key } = await decided();
		expect(
			await workspace.fileReply({
				key,
				from: "Sam@Customer.test",
				body: "Thanks! [@Olivia Owner](mention:user-owner), also in Word?",
			}),
		).toBe(true);

		const snapshot = await workspace.snapshot(alice);
		const comment = snapshot.comments.find((each) => each.issueId === request.id);
		expect(comment).toMatchObject({
			authorId: INTAKE_EMAIL_ACTOR_ID,
			body: "Thanks! [@Olivia Owner](mention:user-owner), also in Word?",
		});
		expect(snapshot.inbox.find((item) => item.issueId === request.id)).toMatchObject({
			event: { type: "comment", commentId: comment?.id },
			actorId: INTAKE_EMAIL_ACTOR_ID,
		});
		// A stranger's text mentions nobody: the owner, who does not follow it, hears nothing.
		const owners = (await workspace.snapshot(owner)).inbox;
		expect(owners.find((item) => item.issueId === request.id)).toBeUndefined();
	});

	it("takes replies only from whom the decision went to, to a request that is still there", async () => {
		const { workspace, as, request, key } = await decided();
		const reply = { key, from: "sam@customer.test", body: "Hello" };
		expect(await workspace.fileReply({ ...reply, from: "mallory@elsewhere.test" })).toBe(false);
		expect(await workspace.fileReply({ ...reply, key: "a".repeat(26) })).toBe(false);
		expect(await workspace.fileReply({ ...reply, key: key.slice(0, 16) })).toBe(false);
		expect(await workspace.fileReply({ ...reply, body: "   " })).toBe(false);
		// The gateway cleans what mail brings; the object refuses whatever it let through (TRK-79).
		expect(await workspace.fileReply({ ...reply, body: "Hello\0" })).toBe(false);
		expect(await workspace.fileReply({ ...reply, body: "Hello \ud83d" })).toBe(false);
		expect((await workspace.snapshot(owner)).comments).toEqual([]);

		await as(owner, { name: "issue.delete", args: { id: request.id } });
		expect(await workspace.fileReply(reply)).toBe(false);
	});

	it("says where a reply to a key would be filed, without filing it", async () => {
		const { workspace, as, request, key } = await decided();
		const before = (await workspace.snapshot(owner)).version;
		// The key alone: the gateway asks before it reads the message, and compares the sender after.
		expect(await workspace.replyTarget(key)).toEqual({ email: "sam@customer.test" });
		expect(await workspace.replyTarget("a".repeat(26))).toBeNull();
		expect(await workspace.replyTarget(key.slice(0, 16))).toBeNull();
		expect(await workspace.replyTarget(key.toUpperCase())).toBeNull();
		expect(await workspace.replyTarget("x".repeat(65))).toBeNull();
		const after = await workspace.snapshot(owner);
		expect(after.version).toBe(before);
		expect(after.comments).toEqual([]);

		await as(owner, { name: "issue.delete", args: { id: request.id } });
		expect(await workspace.replyTarget(key)).toBeNull();
	});

	it("keeps the same address for every reply", async () => {
		const { workspace, request, key } = await decided();
		for (const body of ["One", "Two"]) {
			expect(await workspace.fileReply({ key, from: "sam@customer.test", body })).toBe(true);
		}
		const comments = (await workspace.snapshot(owner)).comments;
		expect(comments.filter((each) => each.issueId === request.id).map((each) => each.body)).toEqual(
			["One", "Two"],
		);
	});
});
