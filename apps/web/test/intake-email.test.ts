import { isActiveIssue, type Snapshot } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
		// Whoever wrote hears of the decision at the address they wrote from.
		if (request) {
			await track.mutate(workspaceId, owner, { name: "issue.accept", args: { id: request.id } });
			await vi.waitFor(async () => {
				const emails = (await track.emails()).filter((email) => email.to === "sam@customer.test");
				expect(emails.map((email) => email.subject)).toEqual([
					"Your request was accepted: Export fails",
				]);
			});
		}
		expect(request).toMatchObject({
			teamId: "team-eng",
			intake: true,
			creatorId: "email",
			description:
				"The export stops at the first row with an emoji.\n\nSent by email from <sam@customer.test>.",
		});
	});

	it("files the requester's reply to the decision as a comment on the request", async () => {
		const to = await turnOn();
		const filed = await track.email(
			"kim@customer.test",
			to,
			message("Kim <kim@customer.test>", to, "Import from Jira"),
		);
		expect(filed.outcome).toBe("ok");
		const request = (await snapshot()).issues.find((issue) => issue.title === "Import from Jira");
		if (!request) throw new Error("Not filed");
		await track.mutate(workspaceId, owner, { name: "issue.accept", args: { id: request.id } });
		const decision = await vi.waitFor(async () => {
			const sent = (await track.emails()).find((email) => email.to === "kim@customer.test");
			if (!sent) throw new Error("Not sent yet");
			return sent;
		});
		// The decision is sent with the request's own address to reply to.
		const replyTo = decision.replyTo ?? "";
		expect(replyTo).toMatch(
			new RegExp(`^${workspaceId.toLowerCase()}\\.[a-z2-7]{26}@${INTAKE_EMAIL_DOMAIN}$`),
		);
		expect(decision.text).toContain("Reply to this email to add to your request");

		const reply = (from: string) =>
			[
				`From: ${from}`,
				`To: ${replyTo}`,
				"Subject: Re: Your request was accepted: Import from Jira",
				`Message-ID: <${crypto.randomUUID()}@customer.test>`,
				"Date: Sun, 01 Nov 2026 13:00:00 +0000",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Great, our Jira is the cloud one.",
				"",
				"On Sun, Nov 1, 2026 at 12:30 PM Track <track@track.test> wrote:",
				"> Your request was accepted",
				"",
			].join("\r\n");
		// Only the address the decision went to may reply.
		expect(
			await track.email("eve@elsewhere.test", replyTo, reply("eve@elsewhere.test")),
		).toMatchObject({ outcome: "rejected", rejectReason: "No such address" });
		expect(
			(await track.email("kim@customer.test", replyTo, reply("Kim <kim@customer.test>"))).outcome,
		).toBe("ok");

		const comments = (await snapshot()).comments.filter((each) => each.issueId === request.id);
		expect(comments).toEqual([
			expect.objectContaining({ authorId: "email", body: "Great, our Jira is the cloud one." }),
		]);
	});

	it("keeps attachments in the bucket and links them from the request", async () => {
		const to = await turnOn();
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
			"base64",
		);
		const raw = [
			"From: Sam <sam@customer.test>",
			`To: ${to}`,
			"Subject: Crash on export",
			`Message-ID: <${crypto.randomUUID()}@customer.test>`,
			"Date: Sun, 01 Nov 2026 12:00:00 +0000",
			"Content-Type: multipart/mixed; boundary=b",
			"",
			"--b",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"It crashes, see attached.",
			"--b",
			"Content-Type: image/png",
			'Content-Disposition: attachment; filename="screen shot.png"',
			"Content-Transfer-Encoding: base64",
			"",
			png.toString("base64"),
			"--b",
			"Content-Type: text/plain",
			'Content-Disposition: attachment; filename="../crash?.log"',
			"",
			"TypeError at line 3",
			"--b--",
			"",
		].join("\r\n");
		expect((await track.email("sam@customer.test", to, raw)).outcome).toBe("ok");

		const request = (await snapshot()).issues
			.filter(isActiveIssue)
			.find((issue) => issue.title === "Crash on export");
		const keys = await track.fileKeys(`${workspaceId}/`);
		expect(keys).toHaveLength(2);
		expect(keys.map((key) => key.split("/").at(-1)).sort()).toEqual([
			"-crash-.log",
			"screen shot.png",
		]);
		expect(request?.description).toMatch(
			new RegExp(
				`^It crashes, see attached\\.\\n\\n!\\[screen shot\\.png\\]\\(/api/files/${workspaceId}/[0-9a-f-]{36}/screen%20shot\\.png\\)\\n\\n\\[-crash-\\.log\\]\\(/api/files/${workspaceId}/[0-9a-f-]{36}/-crash-\\.log\\)\\n\\nSent by email from <sam@customer\\.test>\\.$`,
			),
		);
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
