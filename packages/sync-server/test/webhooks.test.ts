import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type {
	MutationInput,
	WebhookDelivery,
	WebhookInput,
	WebhookPayload,
} from "@gateweave/track-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { Webhook as Verifier } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberProfile, WebhookResult, WorkspaceLink } from "../src";
import * as schema from "../src/db/schema";
import { RETRY_DELAYS_MS } from "../src/webhooks";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const triage: MemberProfile = {
	...owner,
	id: "agent-triage",
	name: "Triage",
	email: "triage@agents.invalid",
	role: "agent",
};

const link: WorkspaceLink = { id: "ws-acme", slug: "acme", origin: "https://track.test" };
const HOOK_URL = "https://hooks.test/track";

interface Received {
	url: string;
	headers: Record<string, string>;
	body: string;
}

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Stands in for every receiver. Deliveries come from the Durable Object, in this isolate. It
 * takes a moment to answer, as a real one does, so sends overlap the way they do in production.
 */
function receiver(status: (count: number) => number = () => 204): Received[] {
	const received: Received[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		await new Promise((resolve) => setTimeout(resolve, 20));
		received.push({
			url: request.url,
			headers: Object.fromEntries(request.headers),
			body: await request.text(),
		});
		return new Response(null, { status: status(received.length) });
	});
	return received;
}

function ok<T>(result: WebhookResult<T>): T {
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
	return result.value;
}

async function workspaceWithTeams() {
	const workspace = freshWorkspace();
	await mutate(workspace, owner, {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
	await mutate(workspace, owner, {
		name: "team.create",
		args: { id: "team-ops", key: "OPS", name: "Operations" },
	});
	return workspace;
}

async function mutate(
	workspace: Workspace,
	member: MemberProfile,
	mutation: MutationInput,
	id = crypto.randomUUID(),
) {
	const result = await workspace.mutate(member, `client-${member.id}`, id, mutation);
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
	return result.version;
}

async function createHook(workspace: Workspace, input: Partial<WebhookInput> = {}) {
	return ok(
		await workspace.createWebhook(owner, link, {
			url: HOOK_URL,
			events: ["issue.created", "issue.updated", "comment.created"],
			teamId: null,
			agentId: null,
			...input,
		}),
	);
}

function createIssue(workspace: Workspace, member: MemberProfile, id: string, teamId = "team-eng") {
	return mutate(workspace, member, {
		name: "issue.create",
		args: { id, teamId, title: `Issue ${id}`, sortOrder: "a0" },
	});
}

async function deliveries(workspace: Workspace): Promise<WebhookDelivery[]> {
	return ok(await workspace.webhooks(owner)).deliveries;
}

/**
 * Runs the alarm until every delivery is settled: sent, failed for good, or waiting out a retry.
 * The alarm the object sets after each change runs on its own too, so a delivery may be on its
 * way already, claimed by that run, when this one finds nothing due.
 */
async function deliver(workspace: Workspace) {
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(workspace);
			const now = Date.now();
			const unsettled = (await deliveries(workspace)).filter(
				(delivery) =>
					delivery.status === "pending" &&
					!(
						delivery.nextAttemptAt !== null &&
						delivery.nextAttemptAt > now &&
						RETRY_DELAYS_MS.includes(delivery.nextAttemptAt - delivery.updatedAt)
					),
			);
			if (unsettled.length > 0) throw new Error(`${unsettled.length} deliveries are unsettled`);
		},
		{ timeout: 5000, interval: 10 },
	);
}

/** Makes every waiting retry due, rather than waiting for its backoff. */
async function skipBackoff(workspace: Workspace) {
	await runInDurableObject(workspace, (_, state) => {
		drizzle(state.storage, { schema })
			.update(schema.webhookDeliveries)
			.set({ nextAttemptAt: 0 })
			.where(eq(schema.webhookDeliveries.status, "pending"))
			.run();
	});
}

function payloadOf(request: Received | undefined): WebhookPayload {
	if (!request) throw new Error("Nothing was delivered");
	return JSON.parse(request.body) as WebhookPayload;
}

/** What arrived, in the order of the changes. Deliveries go out in parallel, in any order. */
function payloads(received: Received[]): WebhookPayload[] {
	const version = (payload: WebhookPayload) =>
		"version" in payload.data ? payload.data.version : 0;
	return received.map(payloadOf).sort((a, b) => version(a) - version(b));
}

describe("delivery", () => {
	it("signs each event so a Standard Webhooks receiver verifies it", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		const { secret } = await createHook(workspace);

		const version = await createIssue(workspace, owner, "issue-1");
		await deliver(workspace);

		expect(received).toHaveLength(1);
		const [request] = received;
		expect(request?.url).toBe(HOOK_URL);
		expect(request?.headers["content-type"]).toBe("application/json");
		const verified = new Verifier(secret).verify(request?.body ?? "", request?.headers ?? {});
		expect(verified).toEqual(payloadOf(request));
		expect(payloadOf(request)).toMatchObject({
			type: "issue.created",
			data: {
				workspace: { id: link.id, slug: link.slug },
				version,
				actor: { id: owner.id, name: owner.name, type: "person" },
				issue: {
					id: "issue-1",
					key: "ENG-1",
					title: "Issue issue-1",
					url: "https://track.test/acme/issue/ENG-1",
				},
			},
		});
		const [delivery] = await deliveries(workspace);
		expect(delivery).toMatchObject({
			id: request?.headers["webhook-id"],
			event: "issue.created",
			status: "delivered",
			attempts: 1,
			responseStatus: 204,
		});
	});

	it("fails verification with another secret", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		const hook = await createHook(workspace);
		const rotated = ok(await workspace.rotateWebhookSecret(owner, hook.webhook.id));

		await createIssue(workspace, owner, "issue-1");
		await deliver(workspace);

		const [request] = received;
		expect(() =>
			new Verifier(hook.secret).verify(request?.body ?? "", request?.headers ?? {}),
		).toThrow();
		expect(new Verifier(rotated).verify(request?.body ?? "", request?.headers ?? {})).toBeTruthy();
	});

	it("says what an update changed, and leaves out reordering", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createIssue(workspace, owner, "issue-1");
		await createHook(workspace, { events: ["issue.updated"] });

		await mutate(workspace, owner, {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { status: "in_progress", sortOrder: "b0" } },
		});
		await mutate(workspace, owner, {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { sortOrder: "c0" } },
		});
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});
		await deliver(workspace);

		const sent = payloads(received);
		expect(sent.map((payload) => payload.data)).toMatchObject([
			{ issue: { status: "in_progress" }, updatedFrom: { status: "backlog" } },
			{ issue: { labelIds: ["label-bug"] }, updatedFrom: { labelIds: [] } },
		]);
		const data = sent[0]?.data;
		expect(data && "updatedFrom" in data && Object.keys(data.updatedFrom)).toEqual(["status"]);
	});

	it("sends an issue's dates and estimate, and what an update changed of them", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createHook(workspace, { events: ["issue.created", "issue.updated"] });

		await mutate(workspace, owner, {
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: "team-eng",
				title: "Launch",
				sortOrder: "a0",
				dueDate: "2026-11-20",
				estimate: 3,
			},
		});
		await mutate(workspace, owner, {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { dueDate: null, startDate: "2026-11-02" } },
		});
		await deliver(workspace);

		const sent = payloads(received);
		expect(sent.map((payload) => payload.data)).toMatchObject([
			{ issue: { startDate: null, dueDate: "2026-11-20", estimate: 3 } },
			{
				issue: { startDate: "2026-11-02", dueDate: null, estimate: 3 },
				updatedFrom: { startDate: null, dueDate: "2026-11-20" },
			},
		]);
	});

	it("names an issue's labels in labelIds order, and reads each name for each event", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-ui", name: "UI", color: "#00ff00" },
		});
		await createIssue(workspace, owner, "issue-1");
		await createHook(workspace, { events: ["issue.updated"] });

		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-ui" },
		});
		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});
		// Renamed after the issue wore it: the next event must say so, with no stale cache.
		await mutate(workspace, owner, {
			name: "label.update",
			args: { id: "label-bug", patch: { name: "Defect" } },
		});
		await mutate(workspace, owner, {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { status: "in_progress" } },
		});
		await deliver(workspace);

		const sent = payloads(received);
		expect(sent.map((payload) => payload.data)).toMatchObject([
			{ issue: { labelIds: ["label-ui"], labels: [{ id: "label-ui", name: "UI" }] } },
			{
				issue: {
					labelIds: ["label-ui", "label-bug"],
					labels: [
						{ id: "label-ui", name: "UI" },
						{ id: "label-bug", name: "Bug" },
					],
				},
			},
			{
				issue: {
					labelIds: ["label-ui", "label-bug"],
					labels: [
						{ id: "label-ui", name: "UI" },
						{ id: "label-bug", name: "Defect" },
					],
				},
			},
		]);
	});

	it("leaves out a label id that has no row, and keeps labelIds as they are", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await createIssue(workspace, owner, "issue-1");
		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});
		await runInDurableObject(workspace, (_, state) => {
			drizzle(state.storage, { schema })
				.update(schema.issues)
				.set({ labelIds: ["label-ghost", "label-bug"] })
				.where(eq(schema.issues.id, "issue-1"))
				.run();
		});
		await createHook(workspace, { events: ["issue.updated"] });
		await mutate(workspace, owner, {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: 0, patch: { status: "in_progress" } },
		});
		await deliver(workspace);

		expect(payloadOf(received[0]).data).toMatchObject({
			issue: {
				labelIds: ["label-ghost", "label-bug"],
				labels: [{ id: "label-bug", name: "Bug" }],
			},
		});
	});

	it("names an issue's labels on a comment event", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await createIssue(workspace, owner, "issue-1");
		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});
		await createHook(workspace, { events: ["comment.created"] });
		await mutate(workspace, alice, {
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-1", body: "Reproduced" },
		});
		await deliver(workspace);

		expect(payloadOf(received[0]).data).toMatchObject({
			issue: { labels: [{ id: "label-bug", name: "Bug" }] },
			comment: { id: "comment-1" },
		});
	});

	it("carries an issue's project, and reports a change of it", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await mutate(workspace, owner, {
			name: "project.create",
			args: { id: "project-1", name: "Launch" },
		});
		await createHook(workspace, { events: ["issue.created", "issue.updated"] });

		await mutate(workspace, owner, {
			name: "issue.create",
			args: {
				id: "issue-1",
				teamId: "team-eng",
				title: "In a project",
				projectId: "project-1",
				sortOrder: "a0",
			},
		});
		await mutate(workspace, owner, {
			name: "project.delete",
			args: { id: "project-1" },
		});
		await deliver(workspace);

		const sent = payloads(received);
		expect(sent.map((payload) => payload.type)).toEqual(["issue.created", "issue.updated"]);
		expect(sent[0]?.data).toMatchObject({ issue: { projectId: "project-1" } });
		expect(sent[1]?.data).toMatchObject({
			issue: { projectId: null },
			updatedFrom: { projectId: "project-1" },
		});
	});

	it("sends comments with their issue", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createIssue(workspace, owner, "issue-1");
		await createHook(workspace, { events: ["comment.created", "comment.deleted"] });

		await mutate(workspace, alice, {
			name: "comment.create",
			args: { id: "comment-1", issueId: "issue-1", body: "On it" },
		});
		await mutate(workspace, alice, { name: "comment.delete", args: { id: "comment-1" } });
		await deliver(workspace);

		expect(payloads(received)).toMatchObject([
			{
				type: "comment.created",
				data: {
					actor: { id: alice.id },
					comment: { id: "comment-1", body: "On it" },
					issue: { key: "ENG-1" },
				},
			},
			{ type: "comment.deleted", data: { comment: { id: "comment-1" } } },
		]);
	});

	it("retries a failed delivery with backoff, then gives up", async () => {
		const received = receiver(() => 503);
		const workspace = await workspaceWithTeams();
		await createHook(workspace);
		await createIssue(workspace, owner, "issue-1");

		await deliver(workspace);
		const [failed] = await deliveries(workspace);
		expect(failed).toMatchObject({ status: "pending", attempts: 1, responseStatus: 503 });
		expect((failed?.nextAttemptAt ?? 0) - (failed?.updatedAt ?? 0)).toBe(RETRY_DELAYS_MS[0]);

		for (const _ of RETRY_DELAYS_MS) {
			await skipBackoff(workspace);
			await deliver(workspace);
		}
		expect(received).toHaveLength(RETRY_DELAYS_MS.length + 1);
		// Each retry carries the same id, so a receiver can tell a retry from a new event.
		expect(new Set(received.map((request) => request.headers["webhook-id"])).size).toBe(1);
		expect(await deliveries(workspace)).toMatchObject([
			{
				status: "failed",
				attempts: RETRY_DELAYS_MS.length + 1,
				nextAttemptAt: null,
				error: "The receiver answered 503",
			},
		]);
	});

	it("delivers on a retry once the receiver is back", async () => {
		receiver((count) => (count === 1 ? 500 : 200));
		const workspace = await workspaceWithTeams();
		await createHook(workspace);
		await createIssue(workspace, owner, "issue-1");

		await deliver(workspace);
		await skipBackoff(workspace);
		await deliver(workspace);

		expect(await deliveries(workspace)).toMatchObject([
			{ status: "delivered", attempts: 2, responseStatus: 200, error: null },
		]);
	});

	it("counts an unreachable receiver as a failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost"));
		const workspace = await workspaceWithTeams();
		await createHook(workspace);
		await createIssue(workspace, owner, "issue-1");

		await deliver(workspace);

		expect(await deliveries(workspace)).toMatchObject([
			{
				status: "pending",
				attempts: 1,
				responseStatus: null,
				error: "Could not reach the receiver: Network connection lost",
			},
		]);
	});

	it("queues nothing for a rejected or repeated mutation", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createHook(workspace);

		await createIssue(workspace, owner, "issue-1");
		const repeated = await workspace.mutate(owner, `client-${owner.id}`, "same-id", {
			name: "issue.create",
			args: { id: "issue-2", teamId: "team-eng", title: "Once", sortOrder: "a1" },
		});
		await workspace.mutate(owner, `client-${owner.id}`, "same-id", {
			name: "issue.create",
			args: { id: "issue-2", teamId: "team-eng", title: "Once", sortOrder: "a1" },
		});
		const rejected = await workspace.mutate(owner, `client-${owner.id}`, "other-id", {
			name: "issue.create",
			args: { id: "issue-3", teamId: "team-missing", title: "Nowhere", sortOrder: "a2" },
		});
		await deliver(workspace);

		expect(repeated.ok).toBe(true);
		expect(rejected.ok).toBe(false);
		expect(payloads(received).map((payload) => payload.data)).toMatchObject([
			{ issue: { id: "issue-1" } },
			{ issue: { id: "issue-2" } },
		]);
	});
});

describe("filters", () => {
	it("does not send an agent's own changes to its webhook", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await workspace.syncMember(triage);
		const forTriage = await createHook(workspace, { agentId: triage.id });
		const forEveryone = await createHook(workspace, { url: "https://other.test/track" });

		await createIssue(workspace, triage, "by-agent");
		await createIssue(workspace, alice, "by-person");
		await deliver(workspace);

		const sent = (await deliveries(workspace)).map((delivery) => delivery.webhookId);
		expect(sent.filter((id) => id === forTriage.webhook.id)).toHaveLength(1);
		expect(sent.filter((id) => id === forEveryone.webhook.id)).toHaveLength(2);
		const toTriage = received.filter((request) => request.url === HOOK_URL).map(payloadOf);
		expect(toTriage).toMatchObject([{ data: { actor: { id: alice.id, type: "person" } } }]);
		const fromAgent = received.filter((request) => request.url !== HOOK_URL).map(payloadOf);
		expect(fromAgent).toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({ actor: { id: triage.id, name: "Triage", type: "agent" } }),
			}),
		);
	});

	it("sends only the events and team a webhook asks for", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createHook(workspace, { events: ["comment.created"], teamId: "team-eng" });

		await createIssue(workspace, owner, "eng-1", "team-eng");
		await createIssue(workspace, owner, "ops-1", "team-ops");
		for (const issueId of ["eng-1", "ops-1"]) {
			await mutate(workspace, owner, {
				name: "comment.create",
				args: { id: `comment-${issueId}`, issueId, body: "Hello" },
			});
		}
		await deliver(workspace);

		expect(received.map(payloadOf)).toMatchObject([
			{ type: "comment.created", data: { issue: { id: "eng-1" } } },
		]);
	});

	it("queues nothing while paused, and drops what was waiting", async () => {
		const received = receiver(() => 500);
		const workspace = await workspaceWithTeams();
		const { webhook } = await createHook(workspace);
		await createIssue(workspace, owner, "issue-1");
		await deliver(workspace);

		const paused = ok(await workspace.updateWebhook(owner, link, webhook.id, { active: false }));
		await createIssue(workspace, owner, "issue-2");
		await skipBackoff(workspace);
		await deliver(workspace);

		expect(paused.active).toBe(false);
		expect(received).toHaveLength(1);
		expect(await deliveries(workspace)).toMatchObject([
			{ status: "failed", error: "Webhook paused" },
		]);
	});
});

describe("proposals", () => {
	const PROPOSAL_EVENTS: WebhookInput["events"] = [
		"proposal.created",
		"proposal.updated",
		"proposal.accepted",
		"proposal.dismissed",
	];
	const OTHER_URL = "https://other.test/track";

	/** A workspace whose triage agent only proposes status and priority changes. */
	async function proposingWorkspace() {
		const workspace = await workspaceWithTeams();
		await workspace.syncMember(triage);
		await mutate(workspace, owner, {
			name: "agent.update",
			args: { id: triage.id, patch: { proposes: ["status", "priority"] } },
		});
		await createIssue(workspace, owner, "issue-1");
		return workspace;
	}

	/** Has the agent propose, and returns the open proposals it was told about. */
	async function propose(workspace: Workspace, issueId: string, patch: Record<string, unknown>) {
		const result = await workspace.mutate(triage, `client-${triage.id}`, crypto.randomUUID(), {
			name: "issue.update",
			args: { id: issueId, baseVersion: 0, patch },
		} as MutationInput);
		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
		return result.proposed;
	}

	const decide = (
		workspace: Workspace,
		person: MemberProfile,
		name: "proposal.accept" | "proposal.dismiss",
		id: string,
	) => mutate(workspace, person, { name, args: { id } });

	const types = (received: Received[]) => payloads(received).map((payload) => payload.type);

	it("names the labels of a proposal's issue", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await mutate(workspace, owner, {
			name: "label.create",
			args: { id: "label-bug", name: "Bug", color: "#ff0000" },
		});
		await mutate(workspace, owner, {
			name: "issue.addLabel",
			args: { id: "issue-1", labelId: "label-bug" },
		});
		await createHook(workspace, { events: ["proposal.created"] });

		await propose(workspace, "issue-1", { status: "done" });
		await deliver(workspace);

		expect(payloads(received)).toMatchObject([
			{
				type: "proposal.created",
				data: { issue: { labels: [{ id: "label-bug", name: "Bug" }] } },
			},
		]);
	});

	it("tells of every step in a proposal's life, with who decided", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await createHook(workspace, { events: PROPOSAL_EVENTS });

		const [status] = await propose(workspace, "issue-1", { status: "done" });
		await propose(workspace, "issue-1", { status: "in_progress" });
		await decide(workspace, alice, "proposal.accept", status?.id ?? "");
		const [priority] = await propose(workspace, "issue-1", { priority: 2 });
		await decide(workspace, alice, "proposal.dismiss", priority?.id ?? "");
		// Proposing what the issue already has withdraws the open proposal.
		const [again] = await propose(workspace, "issue-1", { priority: 3 });
		await propose(workspace, "issue-1", { priority: 0 });
		await deliver(workspace);

		expect(types(received)).toEqual([
			"proposal.created",
			"proposal.updated",
			"proposal.accepted",
			"proposal.created",
			"proposal.dismissed",
			"proposal.created",
			"proposal.dismissed",
		]);
		const [created, updated, accepted, , dismissed, , withdrawn] = payloads(received);
		expect(created).toMatchObject({
			type: "proposal.created",
			data: {
				actor: { id: triage.id, type: "agent" },
				issue: { id: "issue-1", key: "ENG-1" },
				proposal: {
					id: status?.id,
					issueId: "issue-1",
					issueKey: "ENG-1",
					agentId: triage.id,
					change: { type: "status", to: "done" },
					createdAt: status?.createdAt,
					updatedAt: status?.updatedAt,
				},
			},
		});
		expect(updated).toMatchObject({
			data: { proposal: { id: status?.id, change: { type: "status", to: "in_progress" } } },
		});
		expect(accepted).toMatchObject({
			data: {
				actor: { id: alice.id, type: "person" },
				proposal: { id: status?.id, change: { type: "status", to: "in_progress" } },
				decidedBy: { id: alice.id, name: "Alice", type: "person" },
				decidedAt: expect.any(Number),
			},
		});
		expect(dismissed).toMatchObject({
			data: {
				actor: { id: alice.id },
				proposal: { id: priority?.id },
				decidedBy: { id: alice.id },
			},
		});
		expect(withdrawn).toMatchObject({
			data: {
				actor: { id: triage.id, type: "agent" },
				proposal: { id: again?.id },
				decidedBy: { id: triage.id, type: "agent" },
			},
		});
	});

	it("sends an agent's webhook what people decided, not what the agent did", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await createHook(workspace, {
			agentId: triage.id,
			events: [...PROPOSAL_EVENTS, "issue.updated"],
		});

		const [status] = await propose(workspace, "issue-1", { status: "done" });
		await propose(workspace, "issue-1", { status: "in_progress" });
		await decide(workspace, alice, "proposal.accept", status?.id ?? "");
		const [priority] = await propose(workspace, "issue-1", { priority: 2 });
		await decide(workspace, alice, "proposal.dismiss", priority?.id ?? "");
		await propose(workspace, "issue-1", { priority: 3 });
		await propose(workspace, "issue-1", { priority: 0 });
		await deliver(workspace);

		// The accepted change keeps its own issue.updated, made by the person.
		expect(
			received
				.map(payloadOf)
				.map((payload) => payload.type)
				.sort(),
		).toEqual(["issue.updated", "proposal.accepted", "proposal.dismissed"]);
		for (const payload of received.map(payloadOf)) {
			expect(payload.data).toMatchObject({ actor: { id: alice.id } });
		}
	});

	it("limits proposal events to the webhook's team", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await createIssue(workspace, owner, "ops-1", "team-ops");
		await createHook(workspace, { events: PROPOSAL_EVENTS, teamId: "team-eng" });

		await propose(workspace, "issue-1", { status: "done" });
		await propose(workspace, "ops-1", { status: "done" });
		await deliver(workspace);

		expect(received.map(payloadOf)).toMatchObject([
			{ type: "proposal.created", data: { issue: { id: "issue-1" } } },
		]);
	});

	it("says nothing of open proposals when their issue is deleted", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await createHook(workspace, { events: [...PROPOSAL_EVENTS, "issue.deleted"], url: OTHER_URL });

		await propose(workspace, "issue-1", { status: "done" });
		await mutate(workspace, owner, { name: "issue.delete", args: { id: "issue-1" } });
		await deliver(workspace);

		expect(types(received)).toEqual(["proposal.created", "issue.deleted"]);
	});

	it("subscribes to proposal events only when asked", async () => {
		const received = receiver();
		const workspace = await proposingWorkspace();
		await createHook(workspace);

		await propose(workspace, "issue-1", { status: "done" });
		await deliver(workspace);

		expect(received).toHaveLength(0);
	});
});

describe("management", () => {
	it("is for admins only", async () => {
		const workspace = await workspaceWithTeams();
		const { webhook } = await createHook(workspace);

		const attempts = [
			await workspace.webhooks(alice),
			await workspace.createWebhook(alice, link, {
				url: HOOK_URL,
				events: ["issue.created"],
				teamId: null,
				agentId: null,
			}),
			await workspace.updateWebhook(alice, link, webhook.id, { active: false }),
			await workspace.rotateWebhookSecret(alice, webhook.id),
			await workspace.testWebhook(alice, link, webhook.id),
			await workspace.deleteWebhook(alice, webhook.id),
			await workspace.webhooks(triage),
		];
		for (const result of attempts) expect(result).toMatchObject({ ok: false, reason: "forbidden" });
		expect(ok(await workspace.webhooks(owner)).webhooks).toHaveLength(1);
	});

	it("never shows the secret again", async () => {
		const workspace = await workspaceWithTeams();
		const { webhook, secret } = await createHook(workspace);

		expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
		expect(webhook.secretStart).toBe(secret.slice(0, 10));
		expect(JSON.stringify(await workspace.webhooks(owner))).not.toContain(secret);
	});

	it("refuses URLs and targets it cannot send to", async () => {
		const workspace = await workspaceWithTeams();
		const input: WebhookInput = {
			url: HOOK_URL,
			events: ["issue.created"],
			teamId: null,
			agentId: null,
		};
		const refused = async (patch: Partial<WebhookInput>, message: string | RegExp) =>
			expect(await workspace.createWebhook(owner, link, { ...input, ...patch })).toMatchObject({
				ok: false,
				message: expect.stringMatching(message),
			});

		await refused({ url: "http://hooks.test/track" }, "Use an https URL");
		await refused({ url: "https://track.test/api/hook" }, "cannot point at Track itself");
		await refused({ url: "https://user:pass@hooks.test/" }, "user name and password");
		await refused({ url: "ftp://hooks.test/" }, "http or https URL");
		await refused({ events: [] }, "at least one event");
		await refused({ teamId: "team-missing" }, "Team not found");
		await refused({ agentId: alice.id }, "Agent not found");

		// Local development runs on plain http, and so may its receivers.
		const local = { ...link, origin: "http://localhost:4710" };
		expect(
			await workspace.createWebhook(owner, local, { ...input, url: "http://localhost:9000/hook" }),
		).toMatchObject({ ok: true });
	});

	it("allows a limited number of webhooks", async () => {
		const workspace = await workspaceWithTeams();
		for (let i = 0; i < 10; i++) await createHook(workspace);
		expect(
			await workspace.createWebhook(owner, link, {
				url: HOOK_URL,
				events: ["issue.created"],
				teamId: null,
				agentId: null,
			}),
		).toMatchObject({ ok: false, message: expect.stringContaining("at most 10") });
	});

	it("sends a test event on request, and deletes with its deliveries", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		const { webhook, secret } = await createHook(workspace, { events: ["issue.deleted"] });

		ok(await workspace.testWebhook(owner, link, webhook.id));
		await deliver(workspace);

		const [request] = received;
		expect(new Verifier(secret).verify(request?.body ?? "", request?.headers ?? {})).toMatchObject({
			type: "webhook.test",
			data: { workspace: { slug: "acme" }, webhookId: webhook.id },
		});

		ok(await workspace.deleteWebhook(owner, webhook.id));
		expect(ok(await workspace.webhooks(owner))).toEqual({ webhooks: [], deliveries: [] });
		expect(await workspace.deleteWebhook(owner, webhook.id)).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("links issues under the workspace's current slug", async () => {
		const received = receiver();
		const workspace = await workspaceWithTeams();
		await createHook(workspace);

		await workspace.relink("acme-inc");
		await createIssue(workspace, owner, "issue-1");
		await deliver(workspace);

		expect(payloadOf(received[0]).data).toMatchObject({
			workspace: { slug: "acme-inc" },
			issue: { url: "https://track.test/acme-inc/issue/ENG-1" },
		});
	});
});
