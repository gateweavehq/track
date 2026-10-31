import { runDurableObjectAlarm } from "cloudflare:test";
import {
	GITHUB_ACTOR_ID,
	type IssueStatus,
	type MutationInput,
	privateId,
	type Snapshot,
	type WebhookPayload,
} from "@gateweave/track-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberProfile, WebhookResult, WorkspaceLink } from "../src";
import { mentions } from "../src/github";
import { freshWorkspace, type Workspace } from "./client";

const owner: MemberProfile = {
	id: "user-owner",
	name: "Olivia Owner",
	email: "olivia@example.com",
	image: null,
	role: "owner",
};
const alice: MemberProfile = { ...owner, id: "user-alice", name: "Alice", role: "member" };
const link: WorkspaceLink = { id: "ws-acme", slug: "acme", origin: "https://track.test" };

afterEach(() => {
	vi.restoreAllMocks();
});

function ok<T>(result: WebhookResult<T>): T {
	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
	return result.value;
}

/** A workspace with team ENG, issues ENG-1 to ENG-3, and a GitHub connection. */
async function setup() {
	const workspace = freshWorkspace();
	for (const member of [owner, alice]) await workspace.syncMember(member);
	let n = 0;
	const as = async (member: MemberProfile, mutation: MutationInput) => {
		const result = await workspace.mutate(member, `client-${member.id}`, `m-${++n}`, mutation);
		if (!result.ok) throw new Error(`${mutation.name} was refused: ${result.message}`);
		return result;
	};
	await as(owner, { name: "team.create", args: { id: "team-eng", key: "ENG", name: "Eng" } });
	for (const number of [1, 2, 3]) {
		await as(owner, {
			name: "issue.create",
			args: {
				id: `issue-${number}`,
				teamId: "team-eng",
				title: `Issue ${number}`,
				sortOrder: `a${number}`,
			},
		});
	}
	const { connection, secret } = ok(await workspace.createGitHubConnection(owner));
	let deliveries = 0;
	/** Sends a delivery signed with the connection's secret, as GitHub would. */
	const deliver = async (
		event: string,
		payload: unknown,
		{ deliveryId = `delivery-${++deliveries}`, key = secret } = {},
	) => {
		const body = JSON.stringify(payload);
		return workspace.github({
			connectionId: connection.id,
			deliveryId,
			event,
			signature: `sha256=${await hmac(key, body)}`,
			body,
		});
	};
	return { workspace, as, connection, secret, deliver };
}

async function hmac(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface PullRequestFields {
	title?: string;
	body?: string | null;
	state?: "open" | "closed";
	draft?: boolean;
	merged_at?: string | null;
	branch?: string;
}

function pullRequest(action: string, fields: PullRequestFields = {}) {
	const { branch = "eng-1-fix-login", ...rest } = fields;
	return {
		action,
		repository: { full_name: "acme/app" },
		pull_request: {
			id: 9001,
			number: 7,
			title: "Fix login",
			body: null,
			html_url: "https://github.com/acme/app/pull/7",
			state: "open",
			draft: false,
			merged_at: null,
			head: { ref: branch },
			user: { login: "octocat" },
			created_at: "2026-10-30T12:00:00Z",
			...rest,
		},
	};
}

function push(ref: string, commits: { id: string; message: string; distinct?: boolean }[]) {
	return {
		ref,
		repository: { full_name: "acme/app", default_branch: "main" },
		commits: commits.map((commit) => ({
			url: `https://github.com/acme/app/commit/${commit.id}`,
			...commit,
		})),
	};
}

async function statuses(workspace: Workspace): Promise<Record<string, IssueStatus>> {
	const { issues } = await workspace.snapshot(owner);
	return Object.fromEntries(issues.map((issue) => [issue.id, issue.status]));
}

async function setStatus(
	workspace: Workspace,
	as: (member: MemberProfile, mutation: MutationInput) => Promise<unknown>,
	id: string,
	status: IssueStatus,
) {
	const issue = (await workspace.snapshot(owner)).issues.find((row) => row.id === id);
	if (!issue) throw new Error(`No issue ${id}`);
	await as(owner, {
		name: "issue.update",
		args: { id, baseVersion: issue.version, patch: { status } },
	});
}

const pullRequests = async (workspace: Workspace): Promise<Snapshot["pullRequests"]> =>
	(await workspace.snapshot(owner)).pullRequests;

describe("mentions", () => {
	it("finds keys in any case, and closing ones after a closing word", () => {
		expect(mentions("Fixes eng-12 and refs ENG-3; closes: DES-1")).toEqual([
			{ teamKey: "ENG", number: 12, closing: true },
			{ teamKey: "ENG", number: 3, closing: false },
			{ teamKey: "DES", number: 1, closing: true },
		]);
		expect(mentions("feature/eng-4-search", true)).toEqual([
			{ teamKey: "ENG", number: 4, closing: true },
		]);
		expect(mentions("UTF8 is not a key, nor is 12-3 or ENG-")).toEqual([]);
	});
});

describe("connections", () => {
	it("are managed by admins, and show their secret once", async () => {
		const workspace = freshWorkspace();
		for (const member of [owner, alice]) await workspace.syncMember(member);
		expect(await workspace.createGitHubConnection(alice)).toMatchObject({
			ok: false,
			reason: "forbidden",
		});

		const { connection, secret } = ok(await workspace.createGitHubConnection(owner));
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		const listed = ok(await workspace.githubConnections(owner));
		expect(listed).toEqual([connection]);
		expect(JSON.stringify(listed)).not.toContain(secret);

		const rotated = ok(await workspace.rotateGitHubSecret(owner, connection.id));
		expect(rotated).not.toBe(secret);
		ok(await workspace.deleteGitHubConnection(owner, connection.id));
		expect(ok(await workspace.githubConnections(owner))).toEqual([]);
		expect(await workspace.deleteGitHubConnection(owner, connection.id)).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("refuse deliveries with a wrong signature, and to unknown connections", async () => {
		const { workspace, deliver, connection } = await setup();
		const before = (await workspace.snapshot(owner)).version;

		expect(await deliver("pull_request", pullRequest("opened"), { key: "not-the-secret" })).toEqual(
			{
				status: 401,
			},
		);
		const body = JSON.stringify(pullRequest("opened"));
		expect(
			await workspace.github({
				connectionId: connection.id,
				deliveryId: "unsigned",
				event: "pull_request",
				signature: null,
				body,
			}),
		).toEqual({ status: 401 });
		expect(
			await workspace.github({
				connectionId: "no-such-connection",
				deliveryId: "elsewhere",
				event: "pull_request",
				signature: `sha256=${"0".repeat(64)}`,
				body,
			}),
		).toEqual({ status: 404 });

		expect((await workspace.snapshot(owner)).version).toBe(before);
		expect(ok(await workspace.githubConnections(owner))[0]?.lastDeliveryAt).toBeNull();
	});

	it("record the last delivery, a ping included", async () => {
		const { workspace, deliver } = await setup();
		const ping = { zen: "Keep it logically awesome.", organization: { login: "acme" } };
		expect(await deliver("ping", ping)).toEqual({ status: 202 });
		expect(ok(await workspace.githubConnections(owner))[0]).toMatchObject({
			lastEvent: "ping",
			lastRepository: "acme",
		});
		await deliver("pull_request", pullRequest("opened"));
		expect(ok(await workspace.githubConnections(owner))[0]).toMatchObject({
			lastEvent: "pull_request",
			lastRepository: "acme/app",
		});
	});
});

describe("pull requests", () => {
	it("link the issues they mention and move them on as they progress", async () => {
		const { workspace, as, deliver } = await setup();
		await setStatus(workspace, as, "issue-2", "todo");

		await deliver("pull_request", pullRequest("opened", { draft: true, body: "Also ENG-2." }));
		expect(await pullRequests(workspace)).toEqual([
			expect.objectContaining({
				id: "github:9001",
				repository: "acme/app",
				number: 7,
				state: "draft",
				author: "octocat",
				issueIds: ["issue-1", "issue-2"],
				// The branch is named for ENG-1.
				closingIssueIds: ["issue-1"],
			}),
		]);
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "in_progress",
			"issue-2": "in_progress",
			"issue-3": "backlog",
		});

		await deliver("pull_request", pullRequest("ready_for_review", { body: "Also ENG-2." }));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "in_review",
			"issue-2": "in_review",
		});

		const merged = {
			state: "closed",
			merged_at: "2026-10-31T09:00:00Z",
			body: "Also ENG-2.",
		} as const;
		await deliver("pull_request", pullRequest("closed", merged));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "done",
			// Mentioned, not fixed.
			"issue-2": "in_review",
		});
		expect((await pullRequests(workspace))[0]?.state).toBe("merged");

		const history = (await workspace.snapshot(owner)).activities.filter(
			(entry) => entry.issueId === "issue-1" && entry.actorId === GITHUB_ACTOR_ID,
		);
		expect(history.map((entry) => entry.change)).toEqual([
			{ type: "status", from: "backlog", to: "in_progress" },
			{ type: "status", from: "in_progress", to: "in_review" },
			{ type: "status", from: "in_review", to: "done" },
		]);
		expect((await workspace.pullRequests("issue-2")).map((row) => row.number)).toEqual([7]);
		expect(await workspace.pullRequests("issue-3")).toEqual([]);
		expect(history[0]?.source).toEqual({
			type: "pull_request",
			label: "acme/app#7",
			url: "https://github.com/acme/app/pull/7",
		});
	});

	it("close what their title or body says they fix", async () => {
		const { workspace, deliver } = await setup();
		await deliver(
			"pull_request",
			pullRequest("opened", { branch: "login", title: "Fixes ENG-2", body: "Closes eng-3" }),
		);
		expect((await pullRequests(workspace))[0]?.closingIssueIds).toEqual(["issue-2", "issue-3"]);
		await deliver(
			"pull_request",
			pullRequest("closed", {
				branch: "login",
				title: "Fixes ENG-2",
				body: "Closes eng-3",
				state: "closed",
				merged_at: "2026-10-31T09:00:00Z",
			}),
		);
		expect(await statuses(workspace)).toMatchObject({ "issue-2": "done", "issue-3": "done" });
	});

	it("never move an issue back, nor out of done or canceled", async () => {
		const { workspace, as, deliver } = await setup();
		await setStatus(workspace, as, "issue-1", "in_review");
		await setStatus(workspace, as, "issue-2", "canceled");
		await deliver("pull_request", pullRequest("opened", { draft: true, body: "Fixes ENG-2" }));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "in_review",
			"issue-2": "canceled",
		});
		await deliver(
			"pull_request",
			pullRequest("closed", {
				body: "Fixes ENG-2",
				state: "closed",
				merged_at: "2026-10-31T09:00:00Z",
			}),
		);
		expect(await statuses(workspace)).toMatchObject({ "issue-1": "done", "issue-2": "canceled" });
	});

	it("leave linked issues alone on an edit, and move only those it newly links", async () => {
		const { workspace, as, deliver } = await setup();
		await deliver("pull_request", pullRequest("opened"));
		expect((await statuses(workspace))["issue-1"]).toBe("in_review");
		// Someone moves it back on purpose; a new commit or an edit must not undo that.
		await setStatus(workspace, as, "issue-1", "in_progress");
		await deliver("pull_request", pullRequest("synchronize"));
		await deliver("pull_request", pullRequest("edited", { body: "Needs ENG-3 too." }));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "in_progress",
			"issue-3": "in_review",
		});
		// Closing without merging moves nothing.
		await deliver("pull_request", pullRequest("closed", { state: "closed" }));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "in_progress",
			"issue-3": "in_review",
		});
		expect((await pullRequests(workspace))[0]?.state).toBe("closed");
	});

	it("are not kept when they mention no issue of the workspace", async () => {
		const { workspace, as, deliver } = await setup();
		await as(owner, { name: "issue.delete", args: { id: "issue-3" } });
		await deliver(
			"pull_request",
			pullRequest("opened", { branch: "main-fix", body: "See DES-1, ENG-99 and ENG-3." }),
		);
		expect(await pullRequests(workspace)).toEqual([]);
	});

	it("leave the snapshot once their issues are deleted", async () => {
		const { workspace, as, deliver } = await setup();
		await deliver("pull_request", pullRequest("opened"));
		expect(await pullRequests(workspace)).toHaveLength(1);
		await as(owner, { name: "issue.delete", args: { id: "issue-1" } });
		expect(await pullRequests(workspace)).toEqual([]);
	});
});

describe("pushes", () => {
	it("close the issues that commits on the default branch fix", async () => {
		const { workspace, deliver } = await setup();
		await deliver(
			"push",
			push("refs/heads/main", [
				{ id: "abc1234def", message: "Handle uppercase emails\n\nFixes ENG-1, refs ENG-2" },
				{ id: "fff0000aaa", message: "Fixes ENG-3", distinct: false },
			]),
		);
		await deliver("push", push("refs/heads/feature", [{ id: "0123456789", message: "fix ENG-2" }]));
		expect(await statuses(workspace)).toMatchObject({
			"issue-1": "done",
			"issue-2": "backlog",
			"issue-3": "backlog",
		});
		const entry = (await workspace.snapshot(owner)).activities.find(
			(activity) => activity.issueId === "issue-1" && activity.actorId === GITHUB_ACTOR_ID,
		);
		expect(entry?.source).toEqual({
			type: "commit",
			label: "acme/app@abc1234",
			url: "https://github.com/acme/app/commit/abc1234def",
		});
	});
});

describe("GitHub's changes", () => {
	it("apply once when GitHub delivers again", async () => {
		const { workspace, as, deliver } = await setup();
		await deliver("pull_request", pullRequest("opened"), { deliveryId: "same" });
		await setStatus(workspace, as, "issue-1", "todo");
		const version = (await workspace.snapshot(owner)).version;
		expect(await deliver("pull_request", pullRequest("opened"), { deliveryId: "same" })).toEqual({
			status: 202,
		});
		expect((await workspace.snapshot(owner)).version).toBe(version);
		expect((await statuses(workspace))["issue-1"]).toBe("todo");
	});

	it("reach subscribers' inboxes and webhooks as GitHub's", async () => {
		const { workspace, as, deliver } = await setup();
		const sent: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			sent.push(await new Request(input, init).text());
			return new Response(null, { status: 204 });
		});
		ok(
			await workspace.createWebhook(owner, link, {
				url: "https://hooks.test/track",
				events: ["issue.updated"],
				teamId: null,
				agentId: null,
			}),
		);
		await as(alice, { name: "issue.subscribe", args: { issueId: "issue-1", subscribed: true } });
		await deliver("pull_request", pullRequest("opened"));

		const item = (await workspace.snapshot(alice)).inbox.find((row) => row.issueId === "issue-1");
		expect(item).toMatchObject({
			id: privateId("issue-1", alice.id),
			actorId: GITHUB_ACTOR_ID,
			event: { type: "status", from: "backlog", to: "in_review" },
			unread: 1,
		});
		await vi.waitFor(async () => {
			await runDurableObjectAlarm(workspace);
			expect(sent).toHaveLength(1);
		});
		const payload = JSON.parse(sent[0] ?? "") as WebhookPayload;
		expect(payload).toMatchObject({
			type: "issue.updated",
			data: { actor: { id: GITHUB_ACTOR_ID, name: "GitHub", type: "system" } },
		});
	});

	it("make a stale offline edit to the status conflict", async () => {
		const { workspace, deliver } = await setup();
		const stale = (await workspace.snapshot(owner)).issues.find((row) => row.id === "issue-1");
		if (!stale) throw new Error("No issue");
		await deliver("pull_request", pullRequest("opened"));
		const result = await workspace.mutate(owner, "offline-laptop", "late-edit", {
			name: "issue.update",
			args: { id: "issue-1", baseVersion: stale.version, patch: { status: "todo" } },
		});
		expect(result).toMatchObject({ ok: false, reason: "conflict" });
		expect((await statuses(workspace))["issue-1"]).toBe("in_review");
	});
});
