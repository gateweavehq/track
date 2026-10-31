import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	DEFAULT_NOTIFICATIONS,
	EMAIL_DELAY_MS,
	EMAIL_INTERVAL_MS,
	type MutationInput,
	privateId,
} from "@gateweave/track-protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	type InboxDigest,
	LINK_HEADER,
	MEMBER_HEADER,
	type MemberProfile,
	type WorkspaceDO,
	type WorkspaceLink,
} from "../src";
import * as schema from "../src/db/schema";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = {
	...owner,
	id: "user-alice",
	name: "Alice",
	email: "alice@example.com",
	role: "member",
};
const bob: MemberProfile = { ...owner, id: "user-bob", name: "Bob", role: "member" };
const triage: MemberProfile = { ...owner, id: "user-triage", name: "Triage", role: "agent" };
const TEAM_ID = "team-1";
const ISSUE_ID = "issue-1";

/**
 * A workspace with a team, an issue assigned to nobody yet, and every test member in it. `sent`
 * has the digests the object sends.
 */
async function setup({ link = true } = {}) {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, bob, triage]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	await as(owner, {
		name: "issue.create",
		args: { id: ISSUE_ID, teamId: TEAM_ID, title: "Ship email", sortOrder: "a0" },
	});
	if (link) await connect(workspace, owner, LINK);

	const digests: InboxDigest[] = [];
	await runInDurableObject(workspace, (instance: WorkspaceDO) => {
		const hook = instance as unknown as { sendInboxDigest(digest: InboxDigest): Promise<void> };
		vi.spyOn(hook, "sendInboxDigest").mockImplementation(async (digest) => {
			digests.push(digest);
		});
	});

	const update = async (member: MemberProfile, patch: Record<string, unknown>) => {
		const issue = (await workspace.snapshot(owner)).issues.find((row) => row.id === ISSUE_ID);
		if (!issue) throw new Error("No issue");
		await as(member, {
			name: "issue.update",
			args: { id: ISSUE_ID, baseVersion: issue.version, patch },
		} as MutationInput);
	};
	// Alice's digests. The owner, who made the issue, hears of comments too.
	const sent = {
		get alice() {
			return digests.filter((digest) => digest.member.id === alice.id);
		},
	};
	return { workspace, as, update, sent };
}

const LINK: WorkspaceLink = { id: "ws-1", slug: "acme", origin: "https://track.example.com" };

/** Opens and closes a socket, as a browser does through the gateway, which records the link. */
async function connect(workspace: Workspace, member: MemberProfile, link: WorkspaceLink) {
	const response = await workspace.fetch("https://workspace/socket", {
		headers: {
			Upgrade: "websocket",
			[MEMBER_HEADER]: JSON.stringify(member),
			[LINK_HEADER]: JSON.stringify(link),
		},
	});
	response.webSocket?.accept();
	response.webSocket?.close(1000);
}

const comment = (id: string, body = "Looks good") =>
	({ name: "comment.create", args: { id, issueId: ISSUE_ID, body } }) satisfies MutationInput;

/** When the member's item on the issue is to be emailed, read from storage. */
async function emailAt(workspace: Workspace, member: MemberProfile) {
	return runInDurableObject(workspace, (_, state) => {
		const db = drizzle(state.storage, { schema });
		const row = db
			.select({ emailAt: schema.inboxItems.emailAt })
			.from(schema.inboxItems)
			.where(sql`${schema.inboxItems.id} = ${privateId(ISSUE_ID, member.id)}`)
			.get();
		return row?.emailAt ?? null;
	});
}

/**
 * Waits for an alarm run under way, such as one a write asked for, to finish. Each run schedules
 * the next one ahead of now.
 */
async function settled(workspace: Workspace) {
	await vi.waitFor(async () => {
		const alarm = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThan(Date.now());
	});
}

/** Runs the alarm now, rather than when it is scheduled. */
async function alarm(workspace: Workspace) {
	await settled(workspace);
	expect(await runDurableObjectAlarm(workspace)).toBe(true);
}

/** Moves the clock on, as far as email is concerned: waiting email and past digests age. */
async function later(workspace: Workspace, ms: number) {
	await settled(workspace);
	await runInDurableObject(workspace, (_, state) => {
		const db = drizzle(state.storage, { schema });
		db.run(sql`update inbox_items set email_at = email_at - ${ms} where email_at is not null`);
		db.run(
			sql`update notification_settings set emailed_at = emailed_at - ${ms} where emailed_at is not null`,
		);
	});
}

describe("notification settings", () => {
	it("start from the defaults, change by kind, and are a person's own", async () => {
		const { workspace } = await setup();
		expect(await workspace.notificationSettings(alice)).toEqual({
			ok: true,
			value: DEFAULT_NOTIFICATIONS,
		});
		expect(
			await workspace.updateNotificationSettings(alice, { status: "off", proposal: "email" }),
		).toEqual({
			ok: true,
			value: { ...DEFAULT_NOTIFICATIONS, status: "off", proposal: "email" },
		});
		expect(await workspace.notificationSettings(bob)).toEqual({
			ok: true,
			value: DEFAULT_NOTIFICATIONS,
		});

		expect(await workspace.updateNotificationSettings(alice, { status: "loud" })).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(await workspace.updateNotificationSettings(alice, { mentions: "off" })).toMatchObject({
			ok: false,
			reason: "invalid",
		});
		expect(await workspace.notificationSettings(triage)).toMatchObject({
			ok: false,
			reason: "forbidden",
		});
	});

	it("keep a kind turned off out of the inbox, and subscribe all the same", async () => {
		const { workspace, as, update } = await setup();
		await workspace.updateNotificationSettings(alice, { comment: "off" });
		await update(owner, { assigneeId: alice.id });
		await as(alice, {
			name: "inbox.update",
			args: { items: [{ issueId: ISSUE_ID, seen: Date.now() }], patch: { read: true } },
		});

		await as(bob, comment("comment-1"));
		const snapshot = await workspace.snapshot(alice);
		expect(snapshot.inbox[0]).toMatchObject({ event: { type: "assigned" }, unread: 0 });

		await update(bob, { status: "in_progress" });
		expect((await workspace.snapshot(alice)).inbox[0]).toMatchObject({
			event: { type: "status", to: "in_progress" },
			unread: 1,
		});
		expect((await workspace.snapshot(alice)).subscriptions).toEqual([
			expect.objectContaining({ issueId: ISSUE_ID, subscribed: true }),
		]);
	});
});

describe("inbox email", () => {
	it("sends news left unread as a digest, once, after a while", async () => {
		const { workspace, update, as, sent } = await setup();
		const before = Date.now();
		await update(owner, { assigneeId: alice.id });
		await as(bob, comment("comment-1", "Can you take this **today**?"));

		const at = await emailAt(workspace, alice);
		expect(at).toBeGreaterThanOrEqual(before + EMAIL_DELAY_MS);
		// The email's time is never sent to the browser.
		expect((await workspace.snapshot(alice)).inbox[0]).not.toHaveProperty("emailAt");
		await alarm(workspace);
		expect(sent.alice).toEqual([]);
		// The alarm comes back for it.
		const next = await runInDurableObject(workspace, (_, state) => state.storage.getAlarm());
		expect(next).toBeLessThanOrEqual(at ?? 0);

		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toEqual([
			{
				workspace: LINK,
				member: { id: alice.id, name: "Alice", email: "alice@example.com" },
				items: [
					{
						issue: { key: "ENG-1", title: "Ship email" },
						event: { type: "comment", commentId: "comment-1" },
						actor: "Bob",
						unread: 2,
						updatedAt: expect.any(Number),
						comment: "Can you take this **today**?",
					},
				],
			},
		]);
		expect(await emailAt(workspace, alice)).toBeNull();
		await alarm(workspace);
		expect(sent.alice).toHaveLength(1);
	});

	it("leaves out news read, archived or snoozed before its time", async () => {
		const { workspace, as, sent } = await setup();
		await as(alice, { name: "issue.subscribe", args: { issueId: ISSUE_ID, subscribed: true } });
		const patches = [{ read: true }, { archived: true }, { snoozedUntil: Date.now() + 60_000 }];
		for (const [n, patch] of patches.entries()) {
			await as(bob, comment(`comment-${n}`));
			expect(await emailAt(workspace, alice)).not.toBeNull();
			const items = [{ issueId: ISSUE_ID, seen: Date.now() + 1000 }];
			await as(alice, { name: "inbox.update", args: { items, patch } });
			expect(await emailAt(workspace, alice)).toBeNull();
		}
		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toEqual([]);
	});

	it("emails only the kinds a person wants by email", async () => {
		const { workspace, update, as, sent } = await setup();
		await workspace.updateNotificationSettings(alice, { comment: "inbox" });
		await as(alice, { name: "issue.subscribe", args: { issueId: ISSUE_ID, subscribed: true } });
		await as(bob, comment("comment-1"));
		await update(bob, { status: "todo" });
		expect(await emailAt(workspace, alice)).toBeNull();

		// News by email keeps its time when news for the inbox alone follows it.
		await update(owner, { assigneeId: alice.id });
		const at = await emailAt(workspace, alice);
		await update(bob, { status: "in_progress" });
		expect(await emailAt(workspace, alice)).toBe(at);

		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toHaveLength(1);
		expect(sent.alice[0]?.items).toEqual([
			expect.objectContaining({ event: { type: "status", from: "todo", to: "in_progress" } }),
		]);
	});

	it("emails a person at most once an hour from a workspace", async () => {
		const { workspace, update, as, sent } = await setup();
		await update(owner, { assigneeId: alice.id });
		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toHaveLength(1);

		await as(bob, comment("comment-1"));
		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toHaveLength(1);

		await later(workspace, EMAIL_INTERVAL_MS - EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toHaveLength(2);
		expect(sent.alice[1]?.items).toEqual([
			expect.objectContaining({ event: { type: "comment", commentId: "comment-1" } }),
		]);
	});

	it("stops when a person unsubscribes, and drops what was waiting", async () => {
		const { workspace, update, sent } = await setup();
		await update(owner, { assigneeId: alice.id });
		expect(await workspace.unsubscribe(alice.id)).toBe(true);
		expect(await workspace.notificationSettings(alice)).toEqual({
			ok: true,
			value: { ...DEFAULT_NOTIFICATIONS, assigned: "inbox", comment: "inbox" },
		});
		expect(await emailAt(workspace, alice)).toBeNull();
		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toEqual([]);

		expect(await workspace.unsubscribe(triage.id)).toBe(false);
		expect(await workspace.unsubscribe("user-nobody")).toBe(false);
	});

	it("drops email that is due when no link to the workspace was recorded", async () => {
		const { workspace, update, sent } = await setup({ link: false });
		await update(owner, { assigneeId: alice.id });
		await later(workspace, EMAIL_DELAY_MS);
		await alarm(workspace);
		expect(sent.alice).toEqual([]);
		expect(await emailAt(workspace, alice)).toBeNull();
	});
});
