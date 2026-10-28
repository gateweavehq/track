import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RECEIVER_HOST, type ReceivedWebhook, startTrack } from "./track-worker";

// Webhooks (TRK-26) in the built Worker: the workspace's Durable Object delivers each change on
// its own alarm, signed, and its links follow a change of the workspace's slug.

const origin = "https://track.test";
const hookUrl = `https://${RECEIVER_HOST}/track`;

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
		},
		body: init.body && JSON.stringify(init.body),
	});
}

async function ok<T>(response: Promise<Response>): Promise<T> {
	const settled = await response;
	if (!settled.ok) throw new Error(`${settled.status} ${await settled.text()}`);
	return (await settled.json()) as T;
}

/** Checks a Standard Webhooks signature, as a receiver would. */
function verified(request: ReceivedWebhook, secret: string): unknown {
	const id = request.headers["webhook-id"];
	const timestamp = request.headers["webhook-timestamp"];
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${request.body}`);
	expect(request.headers["webhook-signature"]).toBe(`v1,${expected.digest("base64")}`);
	return JSON.parse(request.body);
}

describe("webhooks", () => {
	it("delivers signed events from the workspace and follows a slug change", async () => {
		const client = "203.0.113.70";
		const signUp = await authApi("/sign-up/email", {
			client,
			body: { name: "Wanda", email: "wanda@track.test", password: "a-long-test-password" },
		});
		const { user } = (await signUp.json()) as { user: { id: string } };
		const cookie = signUp.headers
			.getSetCookie()
			.map((each) => each.split(";")[0])
			.join("; ");
		const { id: workspaceId } = await ok<{ id: string }>(
			authApi("/organization/create", { client, cookie, body: { name: "Hooks", slug: "hooks" } }),
		);
		const owner = {
			id: user.id,
			name: "Wanda",
			email: "wanda@track.test",
			image: null,
			role: "owner",
		};
		const team = await track.mutate(workspaceId, owner, {
			name: "team.create",
			args: { id: "team-eng", key: "ENG", name: "Engineering" },
		});
		expect(team.ok).toBe(true);

		// The settings page does this through the gateway, which passes the same link.
		const created = await track.rpc<{ ok: boolean; value: { secret: string } }>(
			workspaceId,
			"createWebhook",
			owner,
			{ id: workspaceId, slug: "hooks", origin },
			{ url: hookUrl, events: ["issue.created"], teamId: null, agentId: null },
		);
		expect(created.ok).toBe(true);
		const { secret } = created.value;

		await track.mutate(workspaceId, owner, {
			name: "issue.create",
			args: { id: "issue-1", teamId: "team-eng", title: "First", sortOrder: "a0" },
		});
		await vi.waitFor(() => expect(track.received).toHaveLength(1), { timeout: 5000 });
		expect(verified(track.received[0] as ReceivedWebhook, secret)).toMatchObject({
			type: "issue.created",
			data: {
				workspace: { id: workspaceId, slug: "hooks" },
				actor: { id: user.id, type: "person" },
				issue: { key: "ENG-1", url: `${origin}/hooks/issue/ENG-1` },
			},
		});

		await ok(
			authApi("/organization/update", {
				client,
				cookie,
				body: { organizationId: workspaceId, data: { slug: "hooks-renamed" } },
			}),
		);
		await track.mutate(workspaceId, owner, {
			name: "issue.create",
			args: { id: "issue-2", teamId: "team-eng", title: "Second", sortOrder: "a1" },
		});
		await vi.waitFor(() => expect(track.received).toHaveLength(2), { timeout: 5000 });
		expect(verified(track.received[1] as ReceivedWebhook, secret)).toMatchObject({
			data: {
				workspace: { slug: "hooks-renamed" },
				issue: { key: "ENG-2", url: `${origin}/hooks-renamed/issue/ENG-2` },
			},
		});
		expect(track.outbound).toEqual([]);
	});
});
