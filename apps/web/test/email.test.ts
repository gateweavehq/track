import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_FROM, type SentEmail, startTrack } from "./track-worker";

// Password reset and invitations by email, against the built Worker with email configured.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

/** Calls Better Auth as Track's own pages do, each test from its own client address. */
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

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function signUp(client: string, name: string, email: string, password: string) {
	const response = await authApi("/sign-up/email", { client, body: { name, email, password } });
	expect(response.status).toBe(200);
	return cookieOf(response);
}

/** Email is sent after the response, so wait for it to arrive. */
async function emailTo(address: string): Promise<SentEmail> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const email = (await track.emails()).find((sent) => sent.to === address);
		if (email) return email;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No email to ${address}`);
}

async function emailsTo(address: string) {
	return (await track.emails()).filter((sent) => sent.to === address);
}

describe("password reset", () => {
	const client = "203.0.113.10";

	it("emails a link that sets a new password and signs out everywhere", async () => {
		const oldSession = await signUp(client, "Sam Ortiz", "sam@example.com", "the-old-password");

		// Someone without an account gets the same answer, and no email.
		for (const email of ["nobody@example.com", "sam@example.com"]) {
			const response = await authApi("/request-password-reset", {
				client,
				body: { email, redirectTo: "/reset-password" },
			});
			expect(response.status).toBe(200);
		}

		const email = await emailTo("sam@example.com");
		expect(email.from).toEqual(EMAIL_FROM);
		expect(email.subject).toBe("Reset your Gateweave Track password");
		const link = /https:\/\/track\.test\/api\/auth\/reset-password\/\S+/.exec(email.text)?.[0];
		if (!link) throw new Error(`No reset link in: ${email.text}`);
		expect(email.html).toContain(link.replaceAll("&", "&amp;"));
		expect(await emailsTo("nobody@example.com")).toEqual([]);

		// The link checks the token and hands it to the app's page.
		const opened = await track.fetch(link, { headers: { "cf-connecting-ip": client } });
		expect(opened.status).toBe(302);
		const page = new URL(opened.headers.get("location") ?? "", origin);
		expect(page.pathname).toBe("/reset-password");
		const token = page.searchParams.get("token");
		if (!token) throw new Error(`No token in ${page.href}`);

		const reset = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "the-new-password" },
		});
		expect(reset.status).toBe(200);

		const session = await authApi("/get-session", { client, cookie: oldSession });
		expect(await session.json()).toBeNull();
		const withNew = await authApi("/sign-in/email", {
			client: "203.0.113.11",
			body: { email: "sam@example.com", password: "the-new-password" },
		});
		expect(withNew.status).toBe(200);
		const withOld = await authApi("/sign-in/email", {
			client: "203.0.113.11",
			body: { email: "sam@example.com", password: "the-old-password" },
		});
		expect(withOld.status).toBe(401);

		// A link works once.
		const again = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "another-password" },
		});
		expect(again.status).toBe(400);
		expect(track.outbound).toEqual([]);
	});
});

describe("invitations", () => {
	const client = "203.0.113.20";

	it("are emailed only by people who verified their own address", async () => {
		const cookie = await signUp(client, "Maya Chen", "maya@example.com", "a-long-test-password");
		const created = await authApi("/organization/create", {
			client,
			cookie,
			body: { name: "Acme & <Co>", slug: "acme" },
		});
		expect(created.status).toBe(200);
		const { id: organizationId } = (await created.json()) as { id: string };

		async function invite(email: string) {
			const response = await authApi("/organization/invite-member", {
				client,
				cookie,
				body: { email, role: "member", organizationId },
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { id: string }).id;
		}

		// Anyone can sign up with any address, so an unverified inviter shares the link instead.
		await invite("lena@example.com");

		await track.db
			.prepare("UPDATE user SET email_verified = 1 WHERE email = ?")
			.bind("maya@example.com")
			.run();
		const invitationId = await invite("diego@example.com");

		const email = await emailTo("diego@example.com");
		expect(email.from).toEqual(EMAIL_FROM);
		expect(email.subject).toBe("Maya Chen invited you to Acme & <Co> on Gateweave Track");
		const link = `${origin}/invite/${invitationId}`;
		expect(email.text).toContain(link);
		expect(email.text).toContain("maya@example.com");
		expect(email.html).toContain(`href="${link}"`);
		expect(email.html).toContain("Acme &amp; &lt;Co&gt;");
		expect(email.html).not.toContain("<Co>");
		expect(await emailsTo("lena@example.com")).toEqual([]);
		expect(track.outbound).toEqual([]);
	});
});
