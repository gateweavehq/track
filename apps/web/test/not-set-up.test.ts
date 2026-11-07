import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTAKE_EMAIL_DOMAIN, startTrack } from "./track-worker";

// A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run
// safely without the database and the secret. So a deployment missing either says why and serves
// nothing else.

const origin = "https://track.test";

describe.each([
	["no database", { withoutDatabase: true }],
	["no secret", { withoutSecret: true }],
])("a deployment with %s", (_, missing) => {
	let worker: Awaited<ReturnType<typeof startTrack>>;

	beforeAll(async () => {
		worker = await startTrack(origin, missing);
	});
	afterAll(() => worker.dispose());

	it.each(["/", "/login", "/api/auth/get-session"])("says why at %s", async (path) => {
		const response = await worker.fetch(`${origin}${path}`);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("docs/self-hosting.md");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
	});

	it("makes no account and no session", async () => {
		const response = await worker.fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				name: "Someone",
				email: "someone@example.com",
				password: "a long enough password",
			}),
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	const from = "someone@example.com";
	const to = `workspace.key@${INTAKE_EMAIL_DOMAIN}`;
	const mail = (...headers: string[]) =>
		[
			`From: ${from}`,
			`To: ${to}`,
			"Subject: Hello",
			"Message-ID: <hello@example.com>",
			...headers,
			"",
			"Hello",
		].join("\r\n");

	it("refuses mail for an intake address", async () => {
		expect(await worker.email(from, to, mail())).toEqual({
			outcome: "rejected",
			rejectReason: "This deployment is not set up to take email",
		});
	});

	it("drops a machine's reply rather than bounce it", async () => {
		expect(await worker.email(from, to, mail("Auto-Submitted: auto-replied"))).toEqual({
			outcome: "ok",
		});
	});
});
