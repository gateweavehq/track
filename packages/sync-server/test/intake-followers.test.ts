import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	EMAIL_DELAY_MS,
	INTAKE_EMAIL_ACTOR_ID,
	INTAKE_FORM_ACTOR_ID,
	type MutationInput,
	privateId,
} from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { describe, expect, it, vi } from "vitest";
import migrations from "../drizzle/migrations";
import {
	type InboxDigest,
	LINK_HEADER,
	MEMBER_HEADER,
	type MemberProfile,
	SESSION_HEADER,
	type WorkspaceDO,
} from "../src";
import * as schema from "../src/db/schema";
import { freshWorkspace, SESSION, type Workspace } from "./client";

// Who hears of a new request (TRK-93): those who follow the team's intake, each by their own choice.

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
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	const follow = (member: MemberProfile, following = true) =>
		as(member, { name: "team.followIntake", args: { teamId: TEAM_ID, following } });
	const openChannel = (patch: { intakeForm?: boolean; intakeEmail?: boolean }, by = owner) =>
		as(by, { name: "team.update", args: { id: TEAM_ID, patch } });
	return { workspace, as, follow, openChannel };
}

const teamOf = async (workspace: Workspace) => {
	const team = (await workspace.snapshot(owner)).teams.find((row) => row.id === TEAM_ID);
	if (!team) throw new Error("No team");
	return team;
};

const followers = async (workspace: Workspace) => (await teamOf(workspace)).intakeFollowers;

/** Files a request through a channel that is on, and says which issue it became. */
async function file(
	workspace: Workspace,
	via: "form" | "email",
	{ title = "Please look at this", description = null as string | null } = {},
) {
	const team = await teamOf(workspace);
	const key = via === "form" ? team.intakeFormKey : team.intakeEmailKey;
	if (!key) throw new Error(`The ${via} is off`);
	const before = new Set((await workspace.snapshot(owner)).issues.map((issue) => issue.id));
	expect(
		await workspace.fileRequest({
			via,
			key,
			title,
			description,
			sortOrder: `a${before.size}`,
			requester: null,
		}),
	).toBe(true);
	const issue = (await workspace.snapshot(owner)).issues.find((row) => !before.has(row.id));
	if (!issue) throw new Error("Nothing was filed");
	return issue;
}

async function itemOf(workspace: Workspace, member: MemberProfile, issueId: string) {
	return (await workspace.snapshot(member)).inbox.find((item) => item.issueId === issueId);
}

async function subscriptionOf(workspace: Workspace, member: MemberProfile, issueId: string) {
	return (await workspace.snapshot(member)).subscriptions.find((row) => row.issueId === issueId);
}

/** When the member's item on the issue is to be emailed, read from storage. */
async function emailAt(workspace: Workspace, member: MemberProfile, issueId: string) {
	return runInDurableObject(workspace, (_, state) => {
		const db = drizzle(state.storage, { schema });
		const row = db
			.select({ emailAt: schema.inboxItems.emailAt })
			.from(schema.inboxItems)
			.where(sql`${schema.inboxItems.id} = ${privateId(issueId, member.id)}`)
			.get();
		return row?.emailAt ?? null;
	});
}

describe("following a team's intake", () => {
	it("is each person's own choice, and nobody follows until they choose to", async () => {
		const { workspace, follow } = await setup();
		expect(await followers(workspace)).toEqual([]);

		await follow(alice);
		await follow(bob);
		expect(await followers(workspace)).toEqual([alice.id, bob.id]);

		await follow(alice, false);
		expect(await followers(workspace)).toEqual([bob.id]);
	});

	it("writes nothing when it changes nothing", async () => {
		const { workspace, follow } = await setup();
		const first = await follow(alice);
		const again = await follow(alice);
		expect(again.version).toBe(first.version);
		expect(await followers(workspace)).toEqual([alice.id]);

		const stopped = await follow(bob, false);
		expect(stopped.version).toBe(first.version);
	});

	it("refuses agents, who have no inbox, and a team that does not exist", async () => {
		const { workspace } = await setup();
		expect(
			await workspace.mutate(triage, "client-bot", "m-agent", {
				name: "team.followIntake",
				args: { teamId: TEAM_ID, following: true },
			}),
		).toMatchObject({ ok: false, reason: "forbidden" });
		expect(
			await workspace.mutate(alice, "client-alice", "m-nothing", {
				name: "team.followIntake",
				args: { teamId: "team-none", following: true },
			}),
		).toMatchObject({ ok: false, reason: "not_found" });
		expect(await followers(workspace)).toEqual([]);
	});

	it("ends when someone leaves the workspace, and does not come back with them", async () => {
		const { workspace, follow } = await setup();
		await follow(alice);
		await follow(bob);

		await workspace.removeMember(alice.id);
		expect(await followers(workspace)).toEqual([bob.id]);

		await workspace.syncMember(alice);
		expect(await followers(workspace)).toEqual([bob.id]);
	});

	it("starts empty for teams from before it", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);

		const followed = migrations.journal.entries.find((entry) =>
			entry.tag.endsWith("_intake_followers"),
		);
		if (!followed) throw new Error("No migration");
		await runInDurableObject(workspace, async (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`alter table teams drop column intake_followers`);
			db.run(sql`delete from __drizzle_migrations where created_at >= ${followed.when}`);
			await migrate(db, migrations);
		});

		expect(await followers(workspace)).toEqual([]);
		// The form it had stays on, and tells nobody, as it did before.
		const issue = await file(workspace, "form");
		expect(await itemOf(workspace, owner, issue.id)).toBeUndefined();
	});
});

describe("opening a way in", () => {
	it("makes whoever turns on the form or the address follow", async () => {
		const form = await setup();
		await form.openChannel({ intakeForm: true });
		expect(await followers(form.workspace)).toEqual([owner.id]);

		const email = await setup();
		await email.openChannel({ intakeEmail: true });
		expect(await followers(email.workspace)).toEqual([owner.id]);
	});

	it("counts them once when they open both, and adds the next admin", async () => {
		const { workspace, openChannel } = await setup();
		const admin: MemberProfile = { ...alice, role: "admin" };
		await workspace.syncMember(admin);
		await openChannel({ intakeForm: true, intakeEmail: true });
		expect(await followers(workspace)).toEqual([owner.id]);

		await openChannel({ intakeForm: false });
		await openChannel({ intakeForm: true }, admin);
		expect(await followers(workspace)).toEqual([owner.id, admin.id]);
	});

	it("leaves alone someone who stopped when they only ask for a new link", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(owner, false);

		await openChannel({ intakeForm: true });
		expect(await followers(workspace)).toEqual([]);

		await openChannel({ intakeEmail: true });
		expect(await followers(workspace)).toEqual([owner.id]);
		await follow(owner, false);
		await openChannel({ intakeEmail: true });
		expect(await followers(workspace)).toEqual([]);
	});

	it("keeps them following when it closes again", async () => {
		const { workspace, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await openChannel({ intakeForm: false });
		expect(await followers(workspace)).toEqual([owner.id]);
	});

	it("does not make anyone follow for other changes to the team", async () => {
		const { workspace, openChannel, as } = await setup();
		await openChannel({ intakeForm: false });
		await as(owner, { name: "team.update", args: { id: TEAM_ID, patch: { name: "Eng" } } });
		expect(await followers(workspace)).toEqual([]);
	});
});

describe("a request from outside", () => {
	it("tells the people who follow, as its channel, and has them follow the request", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true, intakeEmail: true });
		await follow(alice);

		const viaForm = await file(workspace, "form");
		expect(await itemOf(workspace, alice, viaForm.id)).toMatchObject({
			event: { type: "request" },
			actorId: INTAKE_FORM_ACTOR_ID,
			unread: 1,
		});
		expect(await itemOf(workspace, owner, viaForm.id)).toMatchObject({
			event: { type: "request" },
		});
		expect(await subscriptionOf(workspace, alice, viaForm.id)).toMatchObject({ subscribed: true });

		const viaEmail = await file(workspace, "email");
		expect(await itemOf(workspace, alice, viaEmail.id)).toMatchObject({
			event: { type: "request" },
			actorId: INTAKE_EMAIL_ACTOR_ID,
		});
	});

	it("tells nobody else, and its text mentions nobody", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);

		const issue = await file(workspace, "form", {
			description: `Help, [@Bob](mention:${bob.id}) and [@Alice](mention:${alice.id})`,
		});
		expect(await itemOf(workspace, bob, issue.id)).toBeUndefined();
		expect(await subscriptionOf(workspace, bob, issue.id)).toBeUndefined();
		// Alice hears as a follower, not because a stranger named her.
		expect(await itemOf(workspace, alice, issue.id)).toMatchObject({ event: { type: "request" } });
	});

	it("leaves out a follower who turned this kind of news off", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);
		await workspace.updateNotificationSettings(alice, { request: "off" });

		const issue = await file(workspace, "form");
		expect(await itemOf(workspace, alice, issue.id)).toBeUndefined();
		expect(await subscriptionOf(workspace, alice, issue.id)).toBeUndefined();
	});

	it("leaves someone who stopped following out of the next one", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);
		const heard = await file(workspace, "form");
		await follow(alice, false);

		const issue = await file(workspace, "form");
		expect(await itemOf(workspace, alice, issue.id)).toBeUndefined();
		// What they already follow stays, as an issue they subscribed to does.
		expect(await subscriptionOf(workspace, alice, heard.id)).toMatchObject({ subscribed: true });
	});

	it("reaches them later too, through the request they now follow", async () => {
		const { workspace, as, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);
		await follow(owner, false);
		const issue = await file(workspace, "form");

		await as(bob, {
			name: "comment.create",
			args: { id: "c-1", issueId: issue.id, body: "On it" },
		});
		expect(await itemOf(workspace, alice, issue.id)).toMatchObject({
			event: { type: "comment", commentId: "c-1" },
		});
	});

	it("emails what stays unread, and wakes the alarm to do it", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);
		await follow(owner, false);

		const digests: InboxDigest[] = [];
		await workspace.syncMember(alice);
		const socket = await workspace.fetch("https://workspace/socket", {
			headers: {
				Upgrade: "websocket",
				[MEMBER_HEADER]: alice.id,
				[LINK_HEADER]: JSON.stringify({
					id: "ws-1",
					slug: "acme",
					origin: "https://track.example.com",
				}),
				[SESSION_HEADER]: JSON.stringify(SESSION),
			},
		});
		socket.webSocket?.accept();
		socket.webSocket?.close(1000);
		await runInDurableObject(workspace, (instance: WorkspaceDO, state) => {
			const hook = instance as unknown as { sendInboxDigest(digest: InboxDigest): Promise<void> };
			vi.spyOn(hook, "sendInboxDigest").mockImplementation(async (digest) => {
				digests.push(digest);
			});
			return state.storage.deleteAlarm();
		});

		const before = Date.now();
		const issue = await file(workspace, "form", { title: "Refund, please" });
		const at = await emailAt(workspace, alice, issue.id);
		expect(at).toBeGreaterThanOrEqual(before + EMAIL_DELAY_MS);
		expect(at).toBeLessThanOrEqual(Date.now() + EMAIL_DELAY_MS);
		await vi.waitFor(async () => {
			const alarm = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
			expect(alarm).not.toBeNull();
		});

		await vi.waitFor(async () => {
			const alarm = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
			expect(alarm).toBeGreaterThan(Date.now());
		});
		await runInDurableObject(workspace, (_, state) => {
			const db = drizzle(state.storage, { schema });
			db.run(sql`update inbox_items set email_at = 1 where email_at is not null`);
		});
		await runDurableObjectAlarm(workspace);
		await vi.waitFor(() => expect(digests).toHaveLength(1));
		expect(digests[0]?.member.id).toBe(alice.id);
		expect(digests[0]?.items).toEqual([
			expect.objectContaining({
				issue: expect.objectContaining({ title: "Refund, please" }),
				event: { type: "request" },
			}),
		]);
	});

	it("is not emailed to someone who wants it in their inbox only", async () => {
		const { workspace, follow, openChannel } = await setup();
		await openChannel({ intakeForm: true });
		await follow(alice);
		await workspace.updateNotificationSettings(alice, { request: "inbox" });

		const issue = await file(workspace, "form");
		expect(await itemOf(workspace, alice, issue.id)).toMatchObject({ event: { type: "request" } });
		expect(await emailAt(workspace, alice, issue.id)).toBeNull();
	});
});

describe("a request from a member", () => {
	const request = (id: string, args: Record<string, unknown> = {}) =>
		({
			name: "issue.create",
			args: { id, teamId: TEAM_ID, title: "Please", sortOrder: "a0", intake: true, ...args },
		}) as MutationInput;

	it("tells the people who follow, but not whoever filed it", async () => {
		const { workspace, as, follow } = await setup();
		await follow(alice);
		await follow(bob);

		await as(alice, request("r-1"));
		expect(await itemOf(workspace, alice, "r-1")).toBeUndefined();
		expect(await itemOf(workspace, bob, "r-1")).toMatchObject({
			event: { type: "request" },
			actorId: alice.id,
		});
		expect(await subscriptionOf(workspace, bob, "r-1")).toMatchObject({ subscribed: true });
	});

	it("tells them when an agent files it", async () => {
		const { workspace, as, follow } = await setup();
		await follow(alice);
		await as(triage, request("r-1"));
		expect(await itemOf(workspace, alice, "r-1")).toMatchObject({
			event: { type: "request" },
			actorId: triage.id,
		});
	});

	it("says so once to a follower it also assigns or mentions", async () => {
		const { workspace, as, follow } = await setup();
		await follow(alice);
		await follow(bob);

		await as(owner, request("r-1", { assigneeId: alice.id }));
		expect(await itemOf(workspace, alice, "r-1")).toMatchObject({
			event: { type: "assigned" },
			unread: 1,
		});

		await as(owner, request("r-2", { description: `See [@Bob](mention:${bob.id})` }));
		expect(await itemOf(workspace, bob, "r-2")).toMatchObject({
			event: { type: "request" },
			unread: 1,
		});
	});

	it("tells nobody of an imported one or an ordinary issue", async () => {
		const { workspace, as, follow } = await setup();
		await follow(alice);

		await as(owner, request("r-1", { createdAt: Date.UTC(2026, 0, 1) }));
		expect(await itemOf(workspace, alice, "r-1")).toBeUndefined();

		await as(owner, request("i-1", { intake: false }));
		expect(await itemOf(workspace, alice, "i-1")).toBeUndefined();
	});

	it("does not repeat when the same mutation comes twice", async () => {
		const { workspace, follow } = await setup();
		await follow(alice);
		const mutation = request("r-1");
		await workspace.mutate(owner, "client-owner", "m-same", mutation);
		await workspace.mutate(owner, "client-owner", "m-same", mutation);
		expect(await itemOf(workspace, alice, "r-1")).toMatchObject({ unread: 1 });
	});
});
