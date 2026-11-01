import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import {
	intakeAddress,
	isAutomated,
	MAX_EMAILED_TEXT,
	parseIntakeAddress,
	replyFromEmail,
	requestFromEmail,
} from "./intake-email";

const KEY = "abcdefgh234567qr";

describe("intake addresses", () => {
	it("are lowercase, and read back whatever case a mail system gives them", () => {
		const address = intakeAddress("Ws8xYz", KEY, "Requests.Example.com");
		expect(address).toBe(`ws8xyz.${KEY}@requests.example.com`);
		expect(parseIntakeAddress(address.toUpperCase(), "requests.example.com")).toEqual({
			workspaceId: "ws8xyz",
			kind: "team",
			key: KEY,
		});
	});

	it("tell a request's reply address, with its longer key, from a team's", () => {
		const reply = "abcdefgh234567qrstuvwxyz23";
		expect(parseIntakeAddress(`ws.${reply}@requests.example.com`, "requests.example.com")).toEqual({
			workspaceId: "ws",
			kind: "reply",
			key: reply,
		});
		// Neither length in between.
		expect(
			parseIntakeAddress(`ws.${reply.slice(0, 20)}@requests.example.com`, "requests.example.com"),
		).toBeNull();
	});

	it("read nothing at another domain or of another form", () => {
		expect(parseIntakeAddress(`ws.${KEY}@example.com`, "requests.example.com")).toBeNull();
		expect(parseIntakeAddress(`ws.${KEY}@evil.requests.example.com`, "requests.example.com")).toBe(
			null,
		);
		expect(parseIntakeAddress("support@requests.example.com", "requests.example.com")).toBeNull();
		expect(parseIntakeAddress(`ws.${KEY}1@requests.example.com`, "requests.example.com")).toBe(
			null,
		);
		expect(parseIntakeAddress(`w/s.${KEY}@requests.example.com`, "requests.example.com")).toBe(
			null,
		);
	});
});

describe("isAutomated", () => {
	it("tells replies and lists sent by machines from mail people wrote", () => {
		expect(isAutomated(new Headers())).toBe(false);
		expect(isAutomated(new Headers({ "Auto-Submitted": "no" }))).toBe(false);
		expect(isAutomated(new Headers({ "Auto-Submitted": "auto-replied" }))).toBe(true);
		expect(isAutomated(new Headers({ Precedence: "bulk" }))).toBe(true);
		expect(isAutomated(new Headers({ "List-Id": "<news.example.com>" }))).toBe(true);
		expect(isAutomated(new Headers({ "X-Autoreply": "yes" }))).toBe(true);
	});
});

describe("requestFromEmail", () => {
	it("takes the subject as the title and the text, signed by its sender, as the description", async () => {
		const email = await PostalMime.parse(
			[
				"From: Sam <sam@customer.test>",
				"To: ws.abcdefgh234567qr@requests.example.com",
				"Subject: =?UTF-8?Q?Export_fails_for_=C3=A9mojis?=",
				"Content-Type: multipart/mixed; boundary=b",
				"",
				"--b",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"The CSV export stops at the first row with an emoji.",
				"--b",
				"Content-Type: text/csv",
				'Content-Disposition: attachment; filename="rows.csv"',
				"",
				"a,b",
				"--b--",
				"",
			].join("\r\n"),
		);
		expect(requestFromEmail(email, "sam@customer.test")).toEqual({
			title: "Export fails for émojis",
			description:
				"The CSV export stops at the first row with an emoji.\n\nSent by email from <sam@customer.test>. 1 attachment was left out.",
		});
	});

	it("reads an HTML-only email as text, and names the sender when there is no subject", async () => {
		const email = await PostalMime.parse(
			[
				"From: lee@customer.test",
				"Content-Type: text/html; charset=utf-8",
				"",
				"<html><head><style>p{}</style></head><body><p>Dark mode, please &amp; thanks.</p><p>Lee</p></body></html>",
			].join("\r\n"),
		);
		const request = requestFromEmail(email, "lee@customer.test");
		expect(request.title).toBe("Email from lee@customer.test");
		expect(request.description).toBe(
			"Dark mode, please & thanks.\nLee\n\nSent by email from <lee@customer.test>.",
		);
	});

	it("links the attachments kept, and counts the ones left out", () => {
		const request = requestFromEmail(
			{
				subject: "Crash",
				text: "See the screenshot.",
				attachments: [{}, {}, {}] as never[],
			},
			"a@b.test",
			["![shot.png](/api/files/ws/1/shot.png)", "[log.txt](/api/files/ws/2/log.txt)"],
		);
		expect(request.description).toBe(
			"See the screenshot.\n\n![shot.png](/api/files/ws/1/shot.png)\n\n[log.txt](/api/files/ws/2/log.txt)\n\nSent by email from <a@b.test>. 1 attachment was left out.",
		);
	});

	it("cuts a long text short", () => {
		const request = requestFromEmail(
			{ subject: "Long", text: "x".repeat(MAX_EMAILED_TEXT + 10), attachments: [] },
			"a@b.test",
		);
		expect(request.description.length).toBeLessThan(MAX_EMAILED_TEXT + 100);
		expect(request.description).toContain("(Cut short.)");
	});
});

describe("replyFromEmail", () => {
	it("keeps what the reply says and leaves out what it quotes", () => {
		const text = [
			"Thanks, that works.",
			"",
			"Could it be in Word too?",
			"",
			"On Mon, Nov 2, 2026 at 9:00 AM Track <ws.key@requests.example.com>",
			"wrote:",
			"> Your request was accepted",
			"> Engineering accepted your request.",
		].join("\r\n");
		expect(replyFromEmail({ text })).toBe("Thanks, that works.\n\nCould it be in Word too?");
	});

	it("cuts at an Outlook-style original message and drops lines quoted in between", () => {
		const text = "Yes.\n> quoted\nNo.\n\n-----Original Message-----\nFrom: Track";
		expect(replyFromEmail({ text })).toBe("Yes.\nNo.");
		expect(replyFromEmail({ text: "On Monday Track wrote:\n> all quoted" })).toBe("");
	});

	it("reads an HTML-only reply, and cuts a long one short", () => {
		expect(replyFromEmail({ html: "<p>Hi &amp; thanks</p>" })).toBe("Hi & thanks");
		const long = replyFromEmail({ text: "x".repeat(MAX_EMAILED_TEXT + 10) });
		expect(long.endsWith("(Cut short.)")).toBe(true);
	});
});
