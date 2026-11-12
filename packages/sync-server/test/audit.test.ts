import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
	AUDIT_PAGE_SIZE,
	type AuditEvent,
	type AuditPage,
	type GatewayAuditEvent,
	type MutationInput,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberProfile, WebhookResult, WorkspaceLink } from "../src";
import { AUDIT_RETENTION_MS } from "../src/audit";
import * as schema from "../src/db/schema";
import { FORGOTTEN_NAME } from "../src/forget";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = {
	id: "user-alice",
	name: "Alice",
	email: "alice@example.com",
	image: null,
	role: "member",
};
const bot: MemberProfile = {
	id: "agent-bot",
	name: "Triage bot",
	email: "agent-bot@agents.invalid",
	image: null,
	role: "agent",
};
const link: WorkspaceLink = { id: "ws-acme", slug: "acme", origin: "https://track.test" };

afterEach(() => {
	vi.restoreAllMocks();
});

function ok<T>(result: WebhookResult<T>): T {
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
	return result.value;
}

async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice, bot]) await workspace.syncMember(member);
	let n = 0;
	const as = (member: MemberProfile, mutation: MutationInput) =>
		workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
	const must = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await as(member, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
	};
	return { workspace, as, must };
}

/** The whole log, oldest first, as an admin reads it page by page. */
async function log(workspace: Workspace): Promise<{ events: AuditEvent[]; page: AuditPage }> {
	const events: AuditEvent[] = [];
	let before: number | undefined;
	let first: AuditPage | undefined;
	for (;;) {
		const page = ok(await workspace.auditLog(owner, before === undefined ? {} : { before }));
		first ??= page;
		events.push(...page.events);
		if (page.next === null) break;
		before = page.next;
	}
	return { events: events.reverse(), page: first ?? { events: [], people: {}, next: null } };
}

/** Each event as `action target-label detail`, which reads more plainly than the objects. */
function brief(events: AuditEvent[]) {
	return events.map((event) => ({
		action: event.action,
		actorId: event.actorId,
		label: event.target.label,
		detail: event.detail,
	}));
}

describe("the audit log", () => {
	it("records changes to how the workspace is set up, by whom, and nothing else", async () => {
		const { workspace, as, must } = await setup();
		await must(owner, { name: "team.create", args: { id: "team-eng", key: "ENG", name: "Eng" } });
		await must(owner, {
			name: "team.update",
			args: { id: "team-eng", patch: { name: "Engineering", intakeForm: true } },
		});
		// A new link for a form that is on.
		await must(owner, {
			name: "team.update",
			args: { id: "team-eng", patch: { intakeForm: true } },
		});
		// Nothing changes: nothing is recorded.
		await must(owner, {
			name: "team.update",
			args: { id: "team-eng", patch: { name: "Engineering" } },
		});
		// Refused: nothing is recorded.
		const refused = await as(alice, {
			name: "team.update",
			args: { id: "team-eng", patch: { name: "Mine" } },
		});
		expect(refused.ok).toBe(false);
		await must(owner, {
			name: "status.create",
			args: {
				teamId: "team-eng",
				key: "qa",
				name: "QA",
				category: "started",
				sortOrder: "c5",
			},
		});
		await must(owner, {
			name: "status.update",
			args: { teamId: "team-eng", key: "qa", patch: { name: "Quality", color: "#ef4444" } },
		});
		await must(owner, {
			name: "status.delete",
			args: { teamId: "team-eng", key: "qa", moveTo: "todo" },
		});
		// What people write is not the log's business.
		await must(alice, {
			name: "issue.create",
			args: { id: "issue-1", teamId: "team-eng", title: "Secret plans", sortOrder: "a1" },
		});
		await must(alice, {
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-1", body: "Mine" },
		});
		await must(owner, {
			name: "comment.create",
			args: { id: "comment-2", issueId: "issue-1", body: "Theirs" },
		});
		await must(owner, { name: "comment.delete", args: { id: "comment-2" } });
		await must(owner, { name: "comment.delete", args: { id: "comment-1" } });
		await must(owner, {
			name: "agent.update",
			args: { id: bot.id, patch: { proposes: ["status", "title"] } },
		});
		await must(alice, { name: "issue.delete", args: { id: "issue-1" } });

		const { events, page } = await log(workspace);
		expect(brief(events)).toEqual([
			{ action: "team.created", actorId: owner.id, label: "Eng", detail: { key: "ENG" } },
			{
				action: "team.updated",
				actorId: owner.id,
				label: "Engineering",
				detail: { change: "name", from: "Eng", to: "Engineering" },
			},
			{
				action: "team.updated",
				actorId: owner.id,
				label: "Engineering",
				detail: { change: "intakeForm", to: "on" },
			},
			{
				action: "team.updated",
				actorId: owner.id,
				label: "Engineering",
				detail: { change: "intakeForm", to: "renewed" },
			},
			{ action: "status.created", actorId: owner.id, label: "QA", detail: { team: "ENG" } },
			{
				action: "status.updated",
				actorId: owner.id,
				label: "Quality",
				detail: { team: "ENG", change: "name", from: "QA", to: "Quality" },
			},
			{
				action: "status.deleted",
				actorId: owner.id,
				label: "Quality",
				detail: { team: "ENG", moveTo: "Todo" },
			},
			// Only someone else's comment: deleting one's own is no admin's doing.
			{
				action: "comment.deleted",
				actorId: owner.id,
				label: "ENG-1",
				detail: { author: alice.id },
			},
			{
				action: "agent.updated",
				actorId: owner.id,
				label: "Triage bot",
				detail: { from: [], to: ["title", "status"] },
			},
			// The key, never the title.
			{ action: "issue.deleted", actorId: alice.id, label: "ENG-1", detail: {} },
		]);
		expect(JSON.stringify(events)).not.toContain("Secret plans");
		expect(page.people).toEqual({
			[owner.id]: { name: owner.name, image: null, agent: false },
			[alice.id]: { name: alice.name, image: null, agent: false },
			[bot.id]: { name: bot.name, image: null, agent: true },
		});
	});

	it("records the integrations admins manage, naming a webhook by its host only", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
		const { workspace } = await setup();
		const secretPath = "https://hooks.example.com/services/T0/B0/very-secret";
		const { webhook } = ok(
			await workspace.createWebhook(owner, link, {
				url: secretPath,
				events: ["issue.created"],
				teamId: null,
				agentId: null,
			}),
		);
		ok(
			await workspace.updateWebhook(owner, link, webhook.id, {
				url: "https://other.example.net/track",
				active: false,
			}),
		);
		ok(await workspace.updateWebhook(owner, link, webhook.id, { events: ["issue.updated"] }));
		ok(await workspace.rotateWebhookSecret(owner, webhook.id));
		ok(await workspace.deleteWebhook(owner, webhook.id));
		const { connection } = ok(await workspace.createGitHubConnection(owner));
		ok(await workspace.rotateGitHubSecret(owner, connection.id));
		ok(await workspace.deleteGitHubConnection(owner, connection.id));
		const installation = { id: "1234", account: "acme" };
		ok(await workspace.connectGitHubApp(owner, installation));
		// Connecting it again keeps the one there is: no news.
		ok(await workspace.connectGitHubApp(owner, installation));
		// Refused: nothing is recorded.
		const input = { url: secretPath, events: [], teamId: null, agentId: null };
		expect((await workspace.createWebhook(alice, link, input)).ok).toBe(false);

		const { events } = await log(workspace);
		expect(brief(events)).toEqual([
			{ action: "webhook.created", actorId: owner.id, label: "hooks.example.com", detail: {} },
			{
				action: "webhook.updated",
				actorId: owner.id,
				label: "other.example.net",
				detail: { change: "url", from: "hooks.example.com", to: "other.example.net" },
			},
			{
				action: "webhook.updated",
				actorId: owner.id,
				label: "other.example.net",
				detail: { change: "active", to: false },
			},
			{
				action: "webhook.updated",
				actorId: owner.id,
				label: "other.example.net",
				detail: { change: "events" },
			},
			{
				action: "webhook.secretRotated",
				actorId: owner.id,
				label: "other.example.net",
				detail: {},
			},
			{ action: "webhook.deleted", actorId: owner.id, label: "other.example.net", detail: {} },
			{ action: "github.connected", actorId: owner.id, label: null, detail: { app: false } },
			{ action: "github.secretRotated", actorId: owner.id, label: null, detail: {} },
			{ action: "github.disconnected", actorId: owner.id, label: null, detail: {} },
			{ action: "github.connected", actorId: owner.id, label: "acme", detail: { app: true } },
		]);
		expect(JSON.stringify(events)).not.toContain("very-secret");
	});

	it("keeps what the gateway reports, and only the changes the gateway makes", async () => {
		const { workspace } = await setup();
		const invited: GatewayAuditEvent = {
			actorId: owner.id,
			action: "invitation.created",
			target: { type: "invitation", id: "inv-1", label: "bob@example.com" },
			detail: { role: "admin" },
		};
		expect(await workspace.audit(invited)).toBe(true);
		await workspace.audit({
			actorId: owner.id,
			action: "member.roleChanged",
			target: { type: "member", id: alice.id, label: null },
			detail: { from: "member", to: "admin" },
		});
		// The object records its own changes; the gateway cannot make them up.
		expect(await workspace.audit({ ...invited, action: "team.created" })).toBe(false);
		expect(await workspace.audit({ ...invited, detail: { note: "x".repeat(400) } })).toBe(false);

		const { events, page } = await log(workspace);
		expect(brief(events)).toEqual([
			{
				action: "invitation.created",
				actorId: owner.id,
				label: "bob@example.com",
				detail: { role: "admin" },
			},
			{
				action: "member.roleChanged",
				actorId: owner.id,
				label: null,
				detail: { from: "member", to: "admin" },
			},
		]);
		expect(page.people[alice.id]?.name).toBe(alice.name);
	});

	it("is read by admins only", async () => {
		const { workspace } = await setup();
		expect(await workspace.auditLog(alice, {})).toMatchObject({ ok: false, reason: "forbidden" });
		expect(await workspace.auditLog(bot, {})).toMatchObject({ ok: false, reason: "forbidden" });
		const stranger = { ...alice, id: "user-stranger", role: "owner" as const };
		expect(await workspace.auditLog(stranger, {})).toMatchObject({
			ok: false,
			reason: "forbidden",
		});
		await workspace.removeMember(owner.id);
		expect(await workspace.auditLog(owner, {})).toMatchObject({ ok: false, reason: "forbidden" });
	});

	it("comes a page at a time, the newest first", async () => {
		const { workspace } = await setup();
		const count = AUDIT_PAGE_SIZE + 7;
		for (let i = 0; i < count; i++) {
			await workspace.audit({
				actorId: owner.id,
				action: "invitation.created",
				target: { type: "invitation", id: `inv-${i}`, label: `person-${i}@example.com` },
			});
		}
		const first = ok(await workspace.auditLog(owner, {}));
		expect(first.events).toHaveLength(AUDIT_PAGE_SIZE);
		expect(first.events[0]?.target.id).toBe(`inv-${count - 1}`);
		expect(first.next).not.toBeNull();
		const second = ok(await workspace.auditLog(owner, { before: first.next ?? undefined }));
		expect(second.events.map((event) => event.target.id)).toEqual(
			Array.from({ length: 7 }, (_, i) => `inv-${6 - i}`),
		);
		expect(second.next).toBeNull();
	});

	it("forgets someone who deleted their account: their name, and the address they were invited at", async () => {
		const { workspace, must } = await setup();
		await workspace.audit({
			actorId: owner.id,
			action: "invitation.created",
			target: { type: "invitation", id: "inv-1", label: alice.email },
			detail: { role: "member" },
		});
		await workspace.audit({
			actorId: alice.id,
			action: "member.joined",
			target: { type: "member", id: alice.id, label: null },
			detail: { role: "member" },
		});
		await must(owner, { name: "team.create", args: { id: "team-eng", key: "ENG", name: "Eng" } });
		await workspace.forgetPerson(alice.id);

		const { events, page } = await log(workspace);
		expect(events.map((event) => event.target.label)).toEqual([null, null, "Eng"]);
		expect(JSON.stringify(events)).not.toContain(alice.email);
		expect(page.people[alice.id]?.name).toBe(FORGOTTEN_NAME);
		expect(page.people[owner.id]?.name).toBe(owner.name);
	});

	it("drops events after a year", async () => {
		const { workspace } = await setup();
		for (const id of ["old", "new"]) {
			await workspace.audit({
				actorId: owner.id,
				action: "invitation.canceled",
				target: { type: "invitation", id, label: null },
			});
		}
		await runInDurableObject(workspace, (_, state) => {
			drizzle(state.storage, { schema })
				.update(schema.auditEvents)
				.set({ at: Date.now() - AUDIT_RETENTION_MS - 1000 })
				.where(eq(schema.auditEvents.targetId, "old"))
				.run();
		});
		await runDurableObjectAlarm(workspace);
		const { events } = await log(workspace);
		expect(events.map((event) => event.target.id)).toEqual(["new"]);
	});
});
