import type { Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTAKE_EMAIL_DOMAIN, startTrack } from "./track-worker";

// A team's intake email address (TRK-41) in the built Worker: Email Routing hands it mail, and
// mail to the address becomes a request in the team's intake.

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;
let workspaceId: string;
let owner: { id: string; name: string; email: string; image: null; role: string };

beforeAll(async () => {
	track = await startTrack(origin);
	const signUp = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.91", "content-type": "application/json" },
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

/** Turns the team's address on and returns it, in the case a mail system might give it. */
async function turnOn(): Promise<string> {
	await track.mutate(workspaceId, owner, {
		name: "team.update",
		args: { id: "team-eng", patch: { intakeEmail: true } },
	});
	const key = (await snapshot()).teams[0]?.intakeEmailKey;
	if (!key) throw new Error("The address did not turn on");
	return `${workspaceId}.${key}@${INTAKE_EMAIL_DOMAIN}`.toUpperCase();
}

function message(from: string, to: string, subject: string, extra: string[] = []) {
	return [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@customer.test>`,
		"Date: Sun, 01 Nov 2026 12:00:00 +0000",
		...extra,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"The export stops at the first row with an emoji.",
		"",
	].join("\r\n");
}

async function titles() {
	return (await snapshot()).issues.map((issue) => issue.title);
}

describe("intake email", () => {
	it("files mail to a team's address as a request in its intake", async () => {
		const to = await turnOn();
		const result = await track.email(
			"sam@customer.test",
			to,
			message("Sam <sam@customer.test>", to, "Export fails"),
		);
		expect(result.outcome).toBe("ok");
		const [request] = (await snapshot()).issues.filter((issue) => issue.title === "Export fails");
		expect(request).toMatchObject({
			teamId: "team-eng",
			intake: true,
			creatorId: "email",
			description:
				"The export stops at the first row with an emoji.\n\nSent by email from <sam@customer.test>.",
		});
	});

	it("refuses mail to an address that leads nowhere, and drops replies sent by machines", async () => {
		const to = await turnOn();
		const wrongKey = `${workspaceId}.aaaaaaaaaaaaaaaa@${INTAKE_EMAIL_DOMAIN}`;
		const refused = await track.email(
			"sam@customer.test",
			wrongKey,
			message("sam@customer.test", wrongKey, "Lost"),
		);
		expect(refused).toMatchObject({ outcome: "rejected", rejectReason: "No such address" });

		const elsewhere = `support@${INTAKE_EMAIL_DOMAIN}`;
		expect(
			await track.email(
				"sam@customer.test",
				elsewhere,
				message("sam@customer.test", elsewhere, "x"),
			),
		).toMatchObject({ outcome: "rejected" });

		const vacation = await track.email(
			"sam@customer.test",
			to,
			message("sam@customer.test", to, "Out of office", ["Auto-Submitted: auto-replied"]),
		);
		expect(vacation.outcome).toBe("ok");
		expect(await titles()).not.toContain("Out of office");
	});

	it("files nothing once the address is turned off", async () => {
		const to = await turnOn();
		await track.mutate(workspaceId, owner, {
			name: "team.update",
			args: { id: "team-eng", patch: { intakeEmail: false } },
		});
		const result = await track.email(
			"sam@customer.test",
			to,
			message("sam@customer.test", to, "Late"),
		);
		expect(result).toMatchObject({ outcome: "rejected", rejectReason: "No such address" });
		expect(await titles()).not.toContain("Late");
	});

	it("refuses made-up addresses before counting anything against the sender", async () => {
		const to = await turnOn();
		for (let i = 0; i < 12; i++) {
			const madeUp = `${workspaceId}.${"bcdefghijklmnop".slice(0, 15)}${"abcdefghijkl"[i]}@${INTAKE_EMAIL_DOMAIN}`;
			const refused = await track.email(
				"victim@customer.test",
				madeUp,
				message("victim@customer.test", madeUp, `Guess ${i}`),
			);
			expect(refused).toMatchObject({ outcome: "rejected", rejectReason: "No such address" });
		}
		// The sender's allowance is whole: the real address still takes their mail.
		const real = await track.email(
			"victim@customer.test",
			to,
			message("victim@customer.test", to, "Real request"),
		);
		expect(real.outcome).toBe("ok");
		expect(await titles()).toContain("Real request");
	});

	it("limits how many requests one sender emails", async () => {
		const to = await turnOn();
		const outcomes: string[] = [];
		for (let i = 0; i < 11; i++) {
			const result = await track.email(
				"flood@customer.test",
				to,
				message("flood@customer.test", to, `Flood ${i}`),
			);
			outcomes.push(result.outcome);
		}
		expect(outcomes.slice(0, 10)).toEqual(Array(10).fill("ok"));
		expect(outcomes[10]).toBe("rejected");
	});
});
