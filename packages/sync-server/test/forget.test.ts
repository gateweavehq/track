import { runInDurableObject } from "cloudflare:test";
import { CloseCode, type MutationInput, mentionLink } from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";
import type { MemberProfile } from "../src";
import * as schema from "../src/db/schema";
import { freshWorkspace, TestClient, type Workspace, whole } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
// The name is one no other word in these tests contains, so finding it anywhere means something.
const NAME = "Zephyrine Quill";
const EMAIL = "zephyrine@example.com";
const IMAGE = "https://example.com/zephyrine.png";
const person: MemberProfile = {
	id: "user-person",
	name: NAME,
	email: EMAIL,
	image: IMAGE,
	role: "member",
};
const bob: MemberProfile = {
	...owner,
	id: "user-bob",
	name: "Bob",
	email: "bob@example.com",
	role: "member",
};
const triage: MemberProfile = {
	...owner,
	id: "user-triage",
	name: "Triage",
	email: "t@example.com",
	role: "agent",
};

const TEAM_ID = "team-1";
const ISSUE_ID = "issue-1";
const FORGOTTEN = "Deleted member";
const mention = mentionLink({ id: person.id, name: NAME });
const renamed = mentionLink({ id: person.id, name: FORGOTTEN });
const bobsMention = mentionLink({ id: bob.id, name: bob.name });

async function workspaceWithTeam() {
	const workspace = freshWorkspace();
	for (const member of [owner, person, bob, triage]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: TEAM_ID, key: "ENG", name: "Engineering" } });
	return { workspace, as };
}

const createIssue = (args: { id?: string; description?: string; assigneeId?: string } = {}) =>
	({
		name: "issue.create",
		args: { id: ISSUE_ID, teamId: TEAM_ID, title: "Ship it", sortOrder: "a0", ...args },
	}) satisfies MutationInput;

const comment = (id: string, body: string, issueId = ISSUE_ID) =>
	({ name: "comment.create", args: { id, issueId, body } }) satisfies MutationInput;

function stored<T>(
	workspace: Workspace,
	read: (db: ReturnType<typeof drizzle<typeof schema>>) => T,
): Promise<T> {
	return runInDurableObject(workspace, (_, state) => read(drizzle(state.storage, { schema })));
}

/** A replica that holds everything so far, so that what it hears next is what a test did. */
async function upToDate(workspace: Workspace, member: MemberProfile) {
	const { version } = await workspace.snapshot(member);
	const client = await TestClient.connect(workspace, member);
	await client.hello(version);
	return client;
}

/** Everything a replica catching up from the very start gets, as one string. */
async function catchUp(workspace: Workspace, member: MemberProfile) {
	const client = await TestClient.connect(workspace, member);
	const ready = await client.hello();
	const ops = client.ops();
	client.close();
	return { ready, ops, text: JSON.stringify(ops) };
}

describe("forgetting someone who deleted their account", () => {
	it("takes their name, address and picture out of the workspace, and tells replicas", async () => {
		const { workspace } = await workspaceWithTeam();
		const client = await upToDate(workspace, bob);

		await workspace.forgetPerson(person.id);

		const op = await client.op((candidate) => candidate.entity === "member");
		expect(op).toMatchObject({
			id: person.id,
			op: "put",
			data: { name: FORGOTTEN, email: "", image: null, proposes: [] },
		});
		const row = (await workspace.snapshot(owner)).members.find((m) => m.id === person.id);
		expect(row).toMatchObject({ name: FORGOTTEN, email: "", image: null, role: "member" });
		expect(row?.removedAt).toEqual(expect.any(Number));
		client.close();
	});

	it("closes their sockets and refuses new ones", async () => {
		const { workspace } = await workspaceWithTeam();
		const client = await TestClient.live(workspace, person);

		await workspace.forgetPerson(person.id);

		expect((await client.closed()).code).toBe(CloseCode.Forbidden);
		const response = await workspace.fetch("https://workspace/socket", {
			headers: {
				Upgrade: "websocket",
				"x-track-member": person.id,
				"x-track-session": JSON.stringify({ id: "s", expiresAt: Number.MAX_SAFE_INTEGER }),
			},
		});
		expect(response.status).toBe(400);
	});

	it("keeps the date of someone already removed", async () => {
		const { workspace } = await workspaceWithTeam();
		await workspace.removeMember(person.id);
		const removedAt = (await workspace.snapshot(owner)).members.find(
			(m) => m.id === person.id,
		)?.removedAt;

		await workspace.forgetPerson(person.id);

		const row = (await workspace.snapshot(owner)).members.find((m) => m.id === person.id);
		expect(row).toMatchObject({ name: FORGOTTEN, email: "", removedAt });
	});

	it("keeps what they wrote and who did what", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(person, createIssue({ assigneeId: person.id }));
		await as(person, comment("comment-1", "Mine"));

		await workspace.forgetPerson(person.id);

		const snapshot = await workspace.snapshot(owner);
		expect(whole(snapshot.issues[0])).toMatchObject({
			creatorId: person.id,
			assigneeId: person.id,
		});
		expect(snapshot.comments[0]).toMatchObject({ authorId: person.id, body: "Mine" });
	});

	it("renames their mentions wherever Markdown can hold one, and leaves other people's", async () => {
		const { workspace, as } = await workspaceWithTeam();
		const text = `Ask ${mention} or ${bobsMention}`;
		const expected = `Ask ${renamed} or ${bobsMention}`;
		await as(bob, createIssue({ description: text }));
		await as(bob, comment("comment-1", text));
		await as(bob, {
			name: "project.create",
			args: { id: "project-1", name: "Launch", description: text },
		});
		await as(bob, {
			name: "projectUpdate.create",
			args: { id: "update-1", projectId: "project-1", health: "on_track", body: text },
		});
		await as(owner, {
			name: "template.create",
			args: { id: "template-1", teamId: TEAM_ID, name: "Bug", description: text },
		});
		const before = await workspace.snapshot(owner);
		const client = await upToDate(workspace, bob);

		await workspace.forgetPerson(person.id);

		const snapshot = await workspace.snapshot(owner);
		expect(whole(snapshot.issues[0]).description).toBe(expected);
		expect(snapshot.comments[0]?.body).toBe(expected);
		expect(snapshot.projects[0]?.description).toBe(expected);
		expect(snapshot.projectUpdates[0]?.body).toBe(expected);
		expect(snapshot.templates[0]?.description).toBe(expected);
		// Nobody edited these, so they don't say so.
		expect(snapshot.comments[0]?.updatedAt).toBe(before.comments[0]?.updatedAt);
		expect(whole(snapshot.issues[0]).updatedAt).toBe(whole(before.issues[0]).updatedAt);

		for (const entity of ["issue", "comment", "project", "projectUpdate", "template"] as const) {
			const op = await client.op((candidate) => candidate.entity === entity);
			expect(JSON.stringify(op)).not.toContain(NAME);
		}
		client.close();
	});

	it("gives the issue the version of the op that changed it", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue({ description: mention }));
		const client = await upToDate(workspace, bob);

		await workspace.forgetPerson(person.id);

		const op = await client.op((candidate) => candidate.entity === "issue");
		expect(whole((await workspace.snapshot(owner)).issues[0]).version).toBe(op.version);
		client.close();
	});

	it("renames a mention inside code too, since the name is there all the same", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue());
		await as(bob, comment("comment-1", `\`${mention}\``));

		await workspace.forgetPerson(person.id);

		expect((await workspace.snapshot(owner)).comments[0]?.body).toBe(`\`${renamed}\``);
	});

	it("rewrites deleted rows quietly, without bringing them back", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue());
		await as(bob, comment("comment-1", mention));
		await as(bob, { name: "comment.delete", args: { id: "comment-1" } });
		const client = await upToDate(workspace, owner);

		await workspace.forgetPerson(person.id);

		const op = await client.op((candidate) => candidate.entity === "member");
		expect(op.id).toBe(person.id);
		expect(client.ops().filter((candidate) => candidate.entity === "comment")).toEqual([]);
		const row = await stored(workspace, (db) =>
			db.select().from(schema.comments).where(eq(schema.comments.id, "comment-1")).get(),
		);
		expect(row?.body).toBe(renamed);
		client.close();
	});

	it("leaves no trace of them in the log for anyone catching up", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue({ description: mention }));
		await as(bob, comment("comment-1", mention));
		const before = (await catchUp(workspace, owner)).text;
		expect(before).toContain(NAME);
		expect(before).toContain(EMAIL);
		expect(before).toContain(IMAGE);

		await workspace.forgetPerson(person.id);

		const { text, ops } = await catchUp(workspace, owner);
		expect(text).not.toContain(NAME);
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain(IMAGE);
		// The ops that were there still are, in order.
		expect(ops.map((op) => op.version)).toEqual(ops.map((op) => op.version).sort((a, b) => a - b));
		expect(ops.filter((op) => op.entity === "comment").map((op) => op.id)).toContain("comment-1");
	});

	it("takes what was private to them, and nobody else's", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: person.id }));
		await as(owner, comment("comment-1", `${mention} ${bobsMention}`));
		expect((await workspace.snapshot(person)).inbox).not.toEqual([]);
		expect(await workspace.updateNotificationSettings(person, { status: "off" })).toMatchObject({
			ok: true,
		});
		const bobsInbox = (await workspace.snapshot(bob)).inbox;
		expect(bobsInbox).toHaveLength(1);

		await workspace.forgetPerson(person.id);

		const left = await stored(workspace, (db) => ({
			subscriptions: db
				.select()
				.from(schema.subscriptions)
				.where(eq(schema.subscriptions.memberId, person.id))
				.all(),
			inbox: db
				.select()
				.from(schema.inboxItems)
				.where(eq(schema.inboxItems.memberId, person.id))
				.all(),
			settings: db
				.select()
				.from(schema.notificationSettings)
				.where(eq(schema.notificationSettings.memberId, person.id))
				.all(),
			privateOps: db.select().from(schema.oplog).where(eq(schema.oplog.audience, person.id)).all(),
			bobsOps: db.select().from(schema.oplog).where(eq(schema.oplog.audience, bob.id)).all(),
		}));
		expect(left.subscriptions).toEqual([]);
		expect(left.inbox).toEqual([]);
		expect(left.settings).toEqual([]);
		expect(left.privateOps).toEqual([]);
		expect(left.bobsOps).not.toEqual([]);
		expect((await workspace.snapshot(bob)).inbox).toEqual(bobsInbox);
	});

	it("takes them off the intakes they follow", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, {
			name: "team.update",
			args: { id: TEAM_ID, patch: { intakeForm: true } },
		});
		await as(person, { name: "team.followIntake", args: { teamId: TEAM_ID, following: true } });
		expect((await workspace.snapshot(owner)).teams[0]?.intakeFollowers).toContain(person.id);

		await workspace.forgetPerson(person.id);

		expect((await workspace.snapshot(owner)).teams[0]?.intakeFollowers).toEqual([owner.id]);
	});

	it("carries on from the version it reached", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, createIssue({ assigneeId: person.id }));
		await workspace.forgetPerson(person.id);
		const reached = (await workspace.snapshot(owner)).version;

		const { version } = await as(owner, comment("comment-1", "Next"));

		expect(version).toBe(reached + 1);
	});

	it("does nothing the second time, and nothing for someone it never knew", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue({ description: mention, assigneeId: person.id }));
		await workspace.forgetPerson(person.id);
		const first = await workspace.snapshot(owner);
		const client = await upToDate(workspace, bob);

		await workspace.forgetPerson(person.id);
		await workspace.forgetPerson("user-stranger");

		expect(await workspace.snapshot(owner)).toEqual(first);
		// Something after both, to show nothing came before it.
		await as(owner, comment("comment-1", "Next"));
		const op = await client.op((candidate) => candidate.entity === "comment");
		expect(op.version).toBe(first.version + 1);
		expect(client.ops().filter((candidate) => candidate.entity === "member")).toEqual([]);
		client.close();
	});

	it("is not undone by a push that was already on its way", async () => {
		const { workspace } = await workspaceWithTeam();
		await workspace.forgetPerson(person.id);

		await workspace.syncMember(person);

		const row = (await workspace.snapshot(owner)).members.find((m) => m.id === person.id);
		expect(row).toMatchObject({ name: FORGOTTEN, email: "" });
		expect(row?.removedAt).toEqual(expect.any(Number));
	});

	it("takes the name out of the search index, down to its pages", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(bob, createIssue({ description: mention }));
		await as(bob, comment("comment-1", mention));
		const search = (text: string) => workspace.issues({ text, limit: 10 });
		expect(await search("Zephyrine")).toHaveLength(1);

		await workspace.forgetPerson(person.id);

		expect(await search("Zephyrine")).toEqual([]);
		expect(await search("Deleted")).toHaveLength(1);
		const pages = await runInDurableObject(workspace, (_, state) =>
			state.storage.sql
				.exec<{ block: ArrayBuffer | null }>("select block from issue_search_data")
				.toArray()
				.map(({ block }) => (block ? new TextDecoder("latin1").decode(block) : ""))
				.join(""),
		);
		expect(pages).toContain("deleted");
		expect(pages).not.toContain("zephyrine");
	});

	it("takes the name out of a proposal, and the copy in someone's inbox", async () => {
		const { workspace, as } = await workspaceWithTeam();
		await as(owner, {
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["description"] } },
		});
		await as(owner, createIssue());
		const issue = whole((await workspace.snapshot(owner)).issues[0]);
		const { proposed } = await as(triage, {
			name: "issue.update",
			args: { id: ISSUE_ID, baseVersion: issue.version, patch: { description: mention } },
		});
		expect(proposed).toHaveLength(1);
		expect(JSON.stringify((await workspace.snapshot(owner)).inbox)).toContain(NAME);
		const client = await upToDate(workspace, owner);

		await workspace.forgetPerson(person.id);

		const snapshot = await workspace.snapshot(owner);
		expect(snapshot.proposals[0]?.change).toEqual({ type: "description", to: renamed });
		expect(JSON.stringify(snapshot.inbox)).not.toContain(NAME);
		expect(JSON.stringify(snapshot.inbox)).toContain(FORGOTTEN);
		const op = await client.op((candidate) => candidate.entity === "inbox");
		expect(JSON.stringify(op)).toContain(FORGOTTEN);
		client.close();
	});

	it("takes the name out of webhook deliveries, sent or waiting", async () => {
		const { workspace, as } = await workspaceWithTeam();
		const link = { id: "workspace-1", slug: "acme", origin: "https://track.test" };
		const hook = await workspace.createWebhook(owner, link, {
			url: "https://hooks.example.com/track",
			events: ["issue.created", "comment.created"],
			teamId: null,
			agentId: null,
		});
		expect(hook.ok).toBe(true);
		await as(person, createIssue({ description: mention, assigneeId: person.id }));
		await as(bob, comment("comment-1", mention));
		const payloads = () =>
			stored(workspace, (db) =>
				db
					.select({ payload: schema.webhookDeliveries.payload })
					.from(schema.webhookDeliveries)
					.all()
					.map((row) => row.payload),
			);
		const before = await payloads();
		expect(before.join("")).toContain(NAME);

		await workspace.forgetPerson(person.id);

		const after = await payloads();
		expect(after).toHaveLength(before.length);
		expect(after.join("")).not.toContain(NAME);
		const created = after
			.map((payload) => JSON.parse(payload))
			.find((p) => p.type === "issue.created");
		expect(created.data.actor).toMatchObject({ id: person.id, name: FORGOTTEN });
	});
});
