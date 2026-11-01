import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitHubConnection, Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	GITHUB_APP,
	type GitHubPerson,
	githubCode,
	githubOrg,
	githubPersonCode,
	startTrack,
} from "./track-worker";

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

async function connections(workspace = workspaceId) {
	const result = await track.rpc<{ ok: boolean; value: GitHubConnection[] }>(
		workspace,
		"githubConnections",
		owner,
	);
	return result.value.filter((connection) => connection.installation !== null);
}

/** A workspace of the owner's, besides the one the tests share. */
async function createWorkspace(slug: string) {
	const created = await authApi("/organization/create", { name: slug, slug }, owner.cookie);
	return ((await created.json()) as { id: string }).id;
}

/** Which workspace and connection D1 says have the installation. */
function installationRow(installation: number) {
	return track.db
		.prepare(
			"select organization_id as workspace, connection_id as connection from github_installation where installation_id = ?",
		)
		.bind(String(installation))
		.first<{ workspace: string; connection: string }>();
}

/**
 * Calls one of the app's server functions as the person behind `cookie`, the way the settings
 * page does. TanStack Start names them by a hash, which the build's resolver maps to their names.
 */
async function serverFn(name: string, data: Record<string, string>, cookie: string) {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const id = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!id) throw new Error(`No server function ${name} in the build`);
	// `{ data }` as the client serializes it (seroval's JSON), for an object of strings.
	const keys = Object.keys(data);
	const body = {
		t: {
			t: 10,
			i: 0,
			p: {
				k: ["data"],
				v: [{ t: 10, i: 1, p: { k: keys, v: keys.map((key) => ({ t: 1, s: data[key] })) }, o: 0 }],
			},
			o: 0,
		},
		f: 127,
		m: [],
	};
	const response = await track.fetch(`${origin}/_serverFn/${id}`, {
		method: "POST",
		headers: {
			origin,
			cookie,
			"cf-connecting-ip": client,
			"content-type": "application/json",
			"x-tsr-serverFn": "true",
			accept: "application/json",
		},
		body: JSON.stringify(body),
	});
	return response.text();
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

	it("connects only installations on accounts the person controls", async () => {
		// GitHub lists an organization's installation for anyone who can read one of its
		// repositories; a collaborator who is not even a member must not take it.
		const collaborator = await connect(owner.cookie, 41, {
			code: githubPersonCode({ id: 7, installations: [{ id: 41, account: githubOrg(41) }] }),
		});
		expect(collaborator.status).toBe(403);
		expect(await collaborator.text()).toContain("admins");
		// A member of the organization who is not its admin, and an admin who has not accepted yet.
		for (const membership of [
			{ state: "active", role: "member" },
			{ state: "pending", role: "admin" },
		] as const) {
			const response = await connect(owner.cookie, 41, {
				code: githubPersonCode({
					id: 7,
					installations: [{ id: 41, account: githubOrg(41) }],
					memberships: { [githubOrg(41).login]: membership },
				}),
			});
			expect(response.status).toBe(403);
		}
		// Someone else's own account.
		const user = { login: "octocat", id: 583231, type: "User" } as const;
		const theirs = await connect(owner.cookie, 42, {
			code: githubPersonCode({ id: 7, installations: [{ id: 42, account: user }] }),
		});
		expect(theirs.status).toBe(403);
		const ids = (await connections()).map((each) => each.installation?.id);
		expect(ids).not.toContain("41");
		expect(ids).not.toContain("42");
		expect(await installationRow(41)).toBeNull();
		expect(await installationRow(42)).toBeNull();

		// The organization's admin, and the user the installation is for.
		const admin = await connect(owner.cookie, 41, {
			code: githubPersonCode({
				id: 7,
				installations: [{ id: 41, account: githubOrg(41) }],
				memberships: { [githubOrg(41).login]: { state: "active", role: "admin" } },
			}),
		});
		expect(admin.status).toBe(302);
		const own = await connect(owner.cookie, 42, {
			code: githubPersonCode({ id: user.id, installations: [{ id: 42, account: user }] }),
		});
		expect(own.status).toBe(302);
		expect(await connections()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ installation: { id: "41", account: "acme-41" } }),
				expect.objectContaining({ installation: { id: "42", account: "octocat" } }),
			]),
		);
	});

	it("gives an installation to one of several workspaces connecting it at once", async () => {
		const workspaces = [
			await createWorkspace("race-1"),
			await createWorkspace("race-2"),
			await createWorkspace("race-3"),
		];
		// Workers interleave requests only as they happen to, so race a few times.
		for (let round = 0; round < 6; round += 1) {
			const installation = 500 + round;
			// The admins come back from GitHub together, so all are past every check of GitHub's
			// before any has claimed the installation.
			let arrived = 0;
			let release = () => {};
			const together = new Promise<void>((done) => {
				release = done;
			});
			const person: GitHubPerson = {
				id: 1,
				installations: [{ id: installation, account: githubOrg(installation) }],
				memberships: { [githubOrg(installation).login]: { state: "active", role: "admin" } },
				hold: async () => {
					arrived += 1;
					if (arrived === workspaces.length) release();
					await together;
				},
			};
			const statuses = await Promise.all(
				workspaces.map(async (workspace) => {
					const response = await connect(owner.cookie, installation, {
						installState: state(owner.id, { workspace }),
						code: githubPersonCode(person),
					});
					return response.status;
				}),
			);
			expect([...statuses].sort()).toEqual([302, 409, 409]);
			const winner = workspaces[statuses.indexOf(302)];
			const won = (await connections(winner)).find(
				(each) => each.installation?.id === String(installation),
			);
			expect(await installationRow(installation)).toEqual({
				workspace: winner,
				connection: won?.id,
			});
			// The others keep no connection that would never hear from GitHub.
			for (const loser of workspaces.filter((each) => each !== winner)) {
				const ids = (await connections(loser)).map((each) => each.installation?.id);
				expect(ids).not.toContain(String(installation));
			}
		}
	});

	it("lets another workspace connect an installation as soon as it is disconnected", async () => {
		const otherId = await createWorkspace("next");
		expect((await connect(owner.cookie, 61)).status).toBe(302);
		const connection = (await connections()).find((each) => each.installation?.id === "61");
		if (!connection) throw new Error("Installation 61 was not connected");
		const answer = await serverFn(
			"deleteGitHubConnection",
			{ workspace: "apps", id: connection.id },
			owner.cookie,
		);
		expect(answer).not.toContain('"k":["error"]');
		expect((await connections()).map((each) => each.installation?.id)).not.toContain("61");
		expect(await installationRow(61)).toBeNull();

		const next = await connect(owner.cookie, 61, {
			installState: state(owner.id, { workspace: otherId }),
		});
		expect(next.status).toBe(302);
		expect((await installationRow(61))?.workspace).toBe(otherId);
	});
});
