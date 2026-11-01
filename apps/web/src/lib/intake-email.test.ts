import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import {
	intakeAddress,
	isAutomated,
	MAX_EMAILED_TEXT,
	parseIntakeAddress,
	requestFromEmail,
} from "./intake-email";

const KEY = "abcdefgh234567qr";

describe("intake addresses", () => {
	it("are lowercase, and read back whatever case a mail system gives them", () => {
		const address = intakeAddress("Ws8xYz", KEY, "Requests.Example.com");
		expect(address).toBe(`ws8xyz.${KEY}@requests.example.com`);
		expect(parseIntakeAddress(address.toUpperCase(), "requests.example.com")).toEqual({
			workspaceId: "ws8xyz",
			key: KEY,
		});
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
