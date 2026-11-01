import { createHmac } from "node:crypto";
import type { GitHubConnection, Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_APP, githubCode, startTrack } from "./track-worker";

// The GitHub App (TRK-58) in the built Worker: an admin back from installing it connects the
// installation only once GitHub lists it among theirs, and its deliveries, which all come to one
// address, reach the workspace that has it.

const origin = "https://track.test";
const client = "203.0.113.81";

type Member = { id: string; name: string; email: string; image: null; role: string };

let track: Awaited<ReturnType<typeof startTrack>>;
let workspaceId: string;
let owner: Member & { cookie: string };
let member: Member & { cookie: string };

beforeAll(async () => {
	track = await startTrack(origin);
	owner = await signUp("Hana", "hana@track.test", "owner");
	const created = await authApi(
		"/organization/create",
		{ name: "Apps", slug: "apps" },
		owner.cookie,
	);
	workspaceId = ((await created.json()) as { id: string }).id;
	member = await signUp("Ivo", "ivo@track.test", "member");
	await authApi(
		"/organization/add-member",
		{ userId: member.id, role: "member", organizationId: workspaceId },
		owner.cookie,
	);
	await track.mutate(workspaceId, owner, {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
	await track.mutate(workspaceId, owner, {
		name: "issue.create",
		args: { id: "issue-1", teamId: "team-eng", title: "Fix login", sortOrder: "a0" },
	});
});

afterAll(async () => {
	await track?.dispose();
});

async function signUp(name: string, email: string, role: string) {
	const response = await authApi("/sign-up/email", {
		name,
		email,
		password: "a-long-test-password",
	});
	const { user } = (await response.json()) as { user: { id: string } };
	const cookie = response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	return { id: user.id, name, email, image: null, role, cookie };
}

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

/** A state as the app signs it: the one settings send to GitHub, unless `installation` names one. */
function state(
	userId: string,
	{
		expires = Date.now() + 60_000,
		workspace = workspaceId,
		installation = null as number | null,
	} = {},
) {
	const step = installation === null ? "install" : "authorize";
	const payload = `${step}.${workspace}.${userId}.${expires}.${installation ?? "-"}`;
	const mac = createHmac("sha256", track.authSecret)
		.update(`track-github-app:${payload}`)
		.digest("base64url");
	return `${payload}.${mac}`;
}

/** Comes back from installing the app, as GitHub sends the person back to the setup URL. */
function setup(cookie: string, installation: number, installState: string) {
	const query = new URLSearchParams({
		installation_id: String(installation),
		setup_action: "install",
		state: installState,
	});
	return track.fetch(`${origin}/api/github/app/setup?${query}`, { headers: { cookie } });
}

/** Comes back from authorizing the app, as GitHub sends the person back to the callback URL. */
function callback(cookie: string, authorizeState: string, code: string | null) {
	const query = new URLSearchParams({ state: authorizeState });
	if (code !== null) query.set("code", code);
	return track.fetch(`${origin}/api/github/app/callback?${query}`, { headers: { cookie } });
}

/**
 * Installs and authorizes the app as the person behind `cookie`, who sets out with `installState`
 * and whom GitHub knows by `code`. Returns the last response.
 */
async function connect(
	cookie: string,
	installation: number,
	{ installState = state(owner.id), code = githubCode(installation) as string | null } = {},
) {
	const back = await setup(cookie, installation, installState);
	if (back.status !== 302) return back;
	const authorize = new URL(back.headers.get("location") ?? "");
	expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
	expect(authorize.searchParams.get("client_id")).toBe(GITHUB_APP.clientId);
	expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/api/github/app/callback`);
	return callback(cookie, authorize.searchParams.get("state") ?? "", code);
}

async function connections() {
	const result = await track.rpc<{ ok: boolean; value: GitHubConnection[] }>(
		workspaceId,
		"githubConnections",
		owner,
	);
	return result.value.filter((connection) => connection.installation !== null);
}

/** A delivery of the app's about `installation`, signed with `secret`. */
function deliver(
	installation: number,
	payload: object,
	{ event = "pull_request", secret = GITHUB_APP.webhookSecret } = {},
) {
	const body = JSON.stringify({ ...payload, installation: { id: installation } });
	return track.fetch(`${origin}/api/github/app`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
		body,
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

describe("installing the GitHub App", () => {
	it("connects nothing without a valid state from this admin, or GitHub's word", async () => {
		// A made-up or tampered state, and one that has run out.
		expect((await connect(owner.cookie, 11, { installState: "nope" })).status).toBe(400);
		const forged = state(owner.id).replace(/\.[^.]+$/, `.${"A".repeat(43)}`);
		expect((await connect(owner.cookie, 11, { installState: forged })).status).toBe(400);
		const expired = state(owner.id, { expires: Date.now() - 1 });
		expect((await connect(owner.cookie, 11, { installState: expired })).status).toBe(400);
		// Someone else's state, and a member who is not an admin.
		expect((await connect(member.cookie, 11)).status).toBe(403);
		expect((await connect(member.cookie, 11, { installState: state(member.id) })).status).toBe(403);
		// The setup step's state does not stand in for the callback's, and GitHub must vouch for
		// the installation the admin came back from, not another.
		expect((await callback(owner.cookie, state(owner.id), githubCode(11))).status).toBe(400);
		const other = await callback(
			owner.cookie,
			state(owner.id, { installation: 12 }),
			githubCode(11),
		);
		expect(other.status).toBe(403);
		// No code from GitHub, a code it refuses, and an installation the person cannot reach.
		expect((await connect(owner.cookie, 11, { code: null })).status).toBe(400);
		expect((await connect(owner.cookie, 11, { code: "not-a-code" })).status).toBe(403);
		const elsewhere = await connect(owner.cookie, 11, { code: githubCode(12, 13) });
		expect(elsewhere.status).toBe(403);
		expect(await elsewhere.text()).toContain("not yours");

		expect(await connections()).toEqual([]);
	});

	it("says an installation that waits for approval needs it first", async () => {
		const query = new URLSearchParams({ setup_action: "request", state: state(owner.id) });
		const response = await track.fetch(`${origin}/api/github/app/setup?${query}`, {
			headers: { cookie: owner.cookie },
		});
		expect(response.status).toBe(202);
		expect(await response.text()).toContain("approve");
	});

	it("connects an installation GitHub lists for the admin, and takes its deliveries", async () => {
		const response = await connect(owner.cookie, 21);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/apps/settings/github");
		expect(await connections()).toEqual([
			expect.objectContaining({ installation: { id: "21", account: "acme-21" } }),
		]);
		// Coming back again, as after choosing other repositories, keeps the one connection.
		expect((await connect(owner.cookie, 21)).status).toBe(302);
		expect(await connections()).toHaveLength(1);

		expect((await deliver(21, pullRequest, { secret: "not-the-secret" })).status).toBe(401);
		expect((await deliver(21, pullRequest)).status).toBe(202);
		const snapshot = await track.rpc<Snapshot>(workspaceId, "snapshot", owner);
		expect(snapshot.issues[0]?.status).toBe("in_review");
		expect(snapshot.pullRequests).toEqual([expect.objectContaining({ number: 3 })]);
	});

	it("answers deliveries of installations no workspace has, changing nothing", async () => {
		const response = await deliver(99, pullRequest);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			message: "No workspace has connected this installation",
		});
		// The app's ping names no installation.
		const ping = await track.fetch(`${origin}/api/github/app`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "ping",
				"x-github-delivery": crypto.randomUUID(),
			},
			body: JSON.stringify({ zen: "Keep it logically awesome." }),
		});
		expect(ping.status).toBe(202);
	});

	it("keeps an installation to one workspace", async () => {
		const other = await authApi(
			"/organization/create",
			{ name: "Other", slug: "other" },
			owner.cookie,
		);
		const otherId = ((await other.json()) as { id: string }).id;
		const response = await connect(owner.cookie, 21, {
			installState: state(owner.id, { workspace: otherId }),
		});
		expect(response.status).toBe(409);
	});

	it("forgets the installation when the app is uninstalled", async () => {
		await connect(owner.cookie, 31);
		expect((await connections()).map((each) => each.installation?.id)).toContain("31");
		const removed = await deliver(31, { action: "deleted" }, { event: "installation" });
		expect(removed.status).toBe(202);
		expect((await connections()).map((each) => each.installation?.id)).not.toContain("31");
		// It can be installed again, on this workspace or another.
		expect((await connect(owner.cookie, 31)).status).toBe(302);
	});
});
