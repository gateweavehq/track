import { createHmac } from "node:crypto";
import type { Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// GitHub (TRK-19) in the built Worker: deliveries reach a workspace's Durable Object without a
// session, through a gateway that checks the workspace exists and passes the body on unread.

const origin = "https://track.test";
const client = "203.0.113.80";

let track: Awaited<ReturnType<typeof startTrack>>;
let workspaceId: string;
let owner: { id: string; name: string; email: string; image: null; role: string };
let connection: { id: string; secret: string };

beforeAll(async () => {
	track = await startTrack(origin);
	const signUp = await authApi("/sign-up/email", {
		name: "Gita",
		email: "gita@track.test",
		password: "a-long-test-password",
	});
	const { user } = (await signUp.json()) as { user: { id: string } };
	const cookie = signUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await authApi("/organization/create", { name: "Code", slug: "code" }, cookie);
	workspaceId = ((await created.json()) as { id: string }).id;
	owner = { id: user.id, name: "Gita", email: "gita@track.test", image: null, role: "owner" };
	await track.mutate(workspaceId, owner, {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
	await track.mutate(workspaceId, owner, {
		name: "issue.create",
		args: { id: "issue-1", teamId: "team-eng", title: "Fix login", sortOrder: "a0" },
	});
	// The settings page does this through a server function, as the verified member.
	const result = await track.rpc<{
		ok: boolean;
		value: { connection: { id: string }; secret: string };
	}>(workspaceId, "createGitHubConnection", owner);
	expect(result.ok).toBe(true);
	connection = { id: result.value.connection.id, secret: result.value.secret };
});

afterAll(async () => {
	await track?.dispose();
});

function authApi(path: string, body: object, cookie?: string) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

const pullRequest = {
	action: "opened",
	repository: { full_name: "acme/app" },
	pull_request: {
		id: 1,
		number: 3,
		title: "Fix login",
		body: null,
		html_url: "https://github.com/acme/app/pull/3",
		state: "open",
		draft: false,
		merged_at: null,
		head: { ref: "eng-1-fix-login" },
		user: { login: "octocat" },
		created_at: "2026-10-31T09:00:00Z",
	},
};

interface Delivery {
	path?: string;
	body?: string;
	secret?: string;
	headers?: Record<string, string>;
	method?: string;
}

/** Sends a delivery as GitHub does, signed with the connection's secret unless told otherwise. */
function deliver({
	path = `${workspaceId}/${connection.id}`,
	body = JSON.stringify(pullRequest),
	secret = connection.secret,
	headers = {},
	method = "POST",
}: Delivery = {}) {
	const signature = createHmac("sha256", secret).update(body).digest("hex");
	return track.fetch(`${origin}/api/github/${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			"x-github-event": "pull_request",
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": `sha256=${signature}`,
			...headers,
		},
		body: method === "GET" ? undefined : body,
	});
}

describe("GitHub deliveries", () => {
	it("refuse what is not a signed delivery to an existing connection", async () => {
		expect((await deliver({ secret: "not-the-secret" })).status).toBe(401);
		expect((await deliver({ path: `${workspaceId}/no-such-connection` })).status).toBe(404);
		expect((await deliver({ path: `no-such-workspace/${connection.id}` })).status).toBe(404);
		expect((await deliver({ method: "GET" })).status).toBe(405);
		expect((await deliver({ headers: { "x-github-event": "" } })).status).toBe(400);
		const form = await deliver({
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
		expect(form.status).toBe(415);
		expect(await form.json()).toEqual({
			error: "Set the webhook's content type to application/json",
		});
		const large = await deliver({ body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }) });
		expect(large.status).toBe(413);

		const snapshot = await track.rpc<Snapshot>(workspaceId, "snapshot", owner);
		expect(snapshot.pullRequests).toEqual([]);
		expect(snapshot.issues[0]?.status).toBe("backlog");
	});

	it("move the issues a pull request links", async () => {
		const response = await deliver();
		expect(response.status).toBe(202);

		const snapshot = await track.rpc<Snapshot>(workspaceId, "snapshot", owner);
		expect(snapshot.issues[0]?.status).toBe("in_review");
		expect(snapshot.pullRequests).toEqual([
			expect.objectContaining({ repository: "acme/app", number: 3, issueIds: ["issue-1"] }),
		]);
	});
});
