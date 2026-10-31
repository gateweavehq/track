import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Inbox email (TRK-47) in the built Worker. The workspace's Durable Object decides when news has
// waited long enough (sync-server's tests cover that) and hands the digest to the app's subclass,
// which these tests call as the alarm does: it checks D1, writes the email and signs its link to
// turn email off, which works without a session.

const origin = "https://track.test";
const client = "203.0.113.90";

let track: Awaited<ReturnType<typeof startTrack>>;
let workspaceId: string;
let owner: { id: string; name: string; email: string; image: null; role: string };

beforeAll(async () => {
	track = await startTrack(origin);
	const signUp = await authApi("/sign-up/email", {
		name: "Ines",
		email: "ines@track.test",
		password: "a-long-test-password",
	});
	const { user } = (await signUp.json()) as { user: { id: string } };
	const cookie = signUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await authApi("/organization/create", { name: "Mail", slug: "mail" }, cookie);
	workspaceId = ((await created.json()) as { id: string }).id;
	owner = { id: user.id, name: "Ines", email: "ines@track.test", image: null, role: "owner" };
	await track.mutate(workspaceId, owner, {
		name: "team.create",
		args: { id: "team-eng", key: "ENG", name: "Engineering" },
	});
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

/** What the object hands its `sendInboxDigest` (sync-server's `InboxDigest`). */
function digest() {
	return {
		workspace: { id: workspaceId, slug: "mail", origin },
		member: { id: owner.id, name: owner.name, email: owner.email },
		items: [
			{
				issue: { key: "ENG-1", title: "Fix <login>" },
				event: { type: "comment", commentId: "comment-1" },
				actor: "Hal",
				unread: 2,
				updatedAt: Date.now(),
				comment: "Can you look at this today?",
			},
		],
	};
}

/** Digests sent to the owner. Signing up sent them a verification email too. */
async function digests() {
	return (await track.emails()).filter(
		(email) => email.to === owner.email && email.subject.includes("ENG-1"),
	);
}

describe("inbox email", () => {
	it("goes only to a verified address, with a link to turn it off", async () => {
		await track.rpc(workspaceId, "sendInboxDigest", digest());
		expect(await digests()).toEqual([]);

		await track.db.prepare("UPDATE user SET email_verified = 1 WHERE id = ?").bind(owner.id).run();
		await track.rpc(workspaceId, "sendInboxDigest", digest());
		const [email] = await digests();
		expect(email?.subject).toBe("Hal commented on ENG-1: Fix <login>");
		expect(email?.text).toContain(`${origin}/mail/issue/ENG-1`);
		expect(email?.text).toContain("> Can you look at this today?");
		expect(email?.html).toContain("Fix &lt;login&gt;");
		expect(email?.html).toContain(`href="${origin}/mail/settings/notifications"`);

		const unsubscribe = /^<(https:\/\/track\.test\/api\/unsubscribe\/[^>]+)>$/.exec(
			email?.headers?.["List-Unsubscribe"] ?? "",
		)?.[1];
		expect(unsubscribe).toBeDefined();
		expect(email?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

		// Opening the link asks first, so a link scanner changes nothing.
		const page = await track.fetch(unsubscribe ?? "");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<form method="post">');
		expect(await settings()).toMatchObject({ assigned: "email", comment: "email" });

		// A forged or altered link changes nothing.
		const forged = `${unsubscribe?.slice(0, -2)}xx`;
		expect((await track.fetch(forged, { method: "POST" })).status).toBe(404);
		const otherMember = unsubscribe?.replace(owner.id, "someone-else") ?? "";
		expect((await track.fetch(otherMember, { method: "POST" })).status).toBe(404);
		expect(await settings()).toMatchObject({ assigned: "email", comment: "email" });

		// Mail clients post to it for one-click unsubscribe.
		const done = await track.fetch(unsubscribe ?? "", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
		});
		expect(done.status).toBe(200);
		expect(await done.text()).toContain("Inbox emails are off");
		expect(await settings()).toMatchObject({ assigned: "inbox", comment: "inbox" });
		expect(track.outbound).toEqual([]);
	});
});

async function settings() {
	const result = await track.rpc<{ ok: boolean; value: Record<string, string> }>(
		workspaceId,
		"notificationSettings",
		owner,
	);
	return result.value;
}
