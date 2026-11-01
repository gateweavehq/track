import type { Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { solveTurnstileOn, startTrack, TURNSTILE_PASS, TURNSTILE_SITE_KEY } from "./track-worker";

// A team's public request form (TRK-41) in the built Worker: a page of its own, without a
// session, that files requests into the team's intake once Turnstile has passed the person.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;
let workspaceId: string;
let owner: { id: string; name: string; email: string; image: null; role: string };

beforeAll(async () => {
	track = await startTrack(origin);
	const signUp = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.90", "content-type": "application/json" },
		body: JSON.stringify({ name: "Ines", email: "ines@track.test", password: "a-long-password" }),
	});
	const { user } = (await signUp.json()) as { user: { id: string } };
	const cookie = signUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await track.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	});
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

async function snapshot() {
	return track.rpc<Snapshot>(workspaceId, "snapshot", owner);
}

async function turnOn(): Promise<string> {
	await track.mutate(workspaceId, owner, {
		name: "team.update",
		args: { id: "team-eng", patch: { intakeForm: true } },
	});
	const key = (await snapshot()).teams[0]?.intakeFormKey;
	if (!key) throw new Error("The form did not turn on");
	return key;
}

function submit(key: string, fields: Record<string, string>, address = "198.51.100.7") {
	return track.fetch(`${origin}/request/${workspaceId}/${key}`, {
		method: "POST",
		headers: {
			"cf-connecting-ip": address,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields).toString(),
	});
}

describe("request form", () => {
	it("shows a form with Turnstile while the team has it on, and nothing otherwise", async () => {
		const missing = await track.fetch(`${origin}/request/${workspaceId}/${"0".repeat(32)}`);
		expect(missing.status).toBe(404);
		await missing.text();

		const key = await turnOn();
		const page = await track.fetch(`${origin}/request/${workspaceId}/${key}`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		const html = await page.text();
		expect(html).toContain("Engineering at Acme");
		expect(html).toContain(`data-sitekey="${TURNSTILE_SITE_KEY}"`);

		const elsewhere = await track.fetch(`${origin}/request/not-a-workspace/${key}`);
		expect(elsewhere.status).toBe(404);
		await elsewhere.text();
	});

	it("files a request into the team's intake once Turnstile passes the person", async () => {
		const key = await turnOn();
		const refused = await submit(key, {
			title: "Export to PDF",
			description: "",
			email: "",
			"cf-turnstile-response": "fail",
		});
		expect(refused.status).toBe(403);
		// The form comes back with what they typed.
		expect(await refused.text()).toContain('value="Export to PDF"');

		const invalid = await submit(key, {
			title: " ",
			"cf-turnstile-response": TURNSTILE_PASS,
		});
		expect(invalid.status).toBe(400);
		await invalid.text();

		const sent = await submit(key, {
			title: "Export to PDF",
			description: "For the <b>board</b>.",
			email: "sam@customer.test",
			"cf-turnstile-response": TURNSTILE_PASS,
		});
		expect(sent.status).toBe(201);
		expect(await sent.text()).toContain("Request sent");

		const filed = (await snapshot()).issues.filter((issue) => issue.title === "Export to PDF");
		expect(filed).toEqual([
			expect.objectContaining({
				teamId: "team-eng",
				intake: true,
				creatorId: "form",
				description:
					"For the <b>board</b>.\n\nSent through the request form by <sam@customer.test>.",
			}),
		]);
	});

	it("refuses a token solved on another host, as a page elsewhere with the same widget would", async () => {
		const key = await turnOn();
		solveTurnstileOn("elsewhere.test");
		try {
			const response = await submit(key, {
				title: "From elsewhere",
				"cf-turnstile-response": TURNSTILE_PASS,
			});
			expect(response.status).toBe(403);
			await response.text();
		} finally {
			solveTurnstileOn("track.test");
		}
		expect((await snapshot()).issues.some((issue) => issue.title === "From elsewhere")).toBe(false);
	});

	it("emails the person who left an address what the team decided", async () => {
		const key = await turnOn();
		const sent = await submit(key, {
			title: "Offline mode",
			email: "kim@customer.test",
			"cf-turnstile-response": TURNSTILE_PASS,
		});
		expect(sent.status).toBe(201);
		await sent.text();
		const request = (await snapshot()).issues.find((issue) => issue.title === "Offline mode");
		if (!request) throw new Error("Not filed");
		await track.mutate(workspaceId, owner, {
			name: "issue.decline",
			args: {
				id: request.id,
				reply: { id: crypto.randomUUID(), body: "It already works offline." },
			},
		});
		await vi.waitFor(async () => {
			const emails = (await track.emails()).filter((email) => email.to === "kim@customer.test");
			expect(emails).toEqual([
				expect.objectContaining({
					subject: "Your request was declined: Offline mode",
					text: expect.stringContaining("> It already works offline."),
				}),
			]);
		});
	});

	it("files nothing once the form is off or its link replaced", async () => {
		const old = await turnOn();
		await turnOn();
		const replaced = await submit(old, { title: "Late", "cf-turnstile-response": TURNSTILE_PASS });
		expect(replaced.status).toBe(404);
		await replaced.text();
		expect((await snapshot()).issues.some((issue) => issue.title === "Late")).toBe(false);
	});

	it("limits how many requests one client network files", async () => {
		const key = await turnOn();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const response = await submit(
				key,
				{ title: `Request ${i}`, "cf-turnstile-response": TURNSTILE_PASS },
				"192.0.2.44",
			);
			statuses.push(response.status);
			await response.text();
		}
		expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
		expect(statuses[10]).toBe(429);
	});
});

describe("request form on the public demo", () => {
	it("is not there", async () => {
		const demo = await startTrack(origin, { demo: true });
		try {
			const response = await demo.fetch(`${origin}/request/${workspaceId}/${"a".repeat(32)}`);
			expect(response.status).toBe(404);
			await response.text();
		} finally {
			await demo.dispose();
		}
	});
});
