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

describe("an HTML-only email", () => {
	const read = (html: string) => replyFromEmail({ html });

	it("loses its tags, and what its scripts, styles and head hold", () => {
		expect(
			read(
				'<html><HEAD><title>Not this</title></HEAD><body><style type="text/css">p{}</style><p class="a">Hello <b>there</b></p><SCRIPT>alert(1)</SCRIPT><p>Lee</p></body></html>',
			),
		).toBe("Hello there\nLee");
	});

	it("keeps paragraphs and line breaks, whatever their case", () => {
		expect(
			read("one<br>two<BR/>three<br />four</P>five</div>six</li>seven</tr>eight</H2>nine"),
		).toBe("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine");
		// Only an element's end makes a new line, and only one that ends a block.
		expect(read("<p>one</span> two <header>three</header>")).toBe("one two three");
	});

	it("reads each entity once", () => {
		expect(read("&lt;b&gt; &quot;x&quot; &#39;y&#39; a&nbsp;b &amp;lt; &unknown;")).toBe(
			`<b> "x" 'y' a b &lt; &unknown;`,
		);
		expect(read("&<b>lt;</b>")).toBe("<");
	});

	it("takes the spaces off the end of lines, and at most one line stays blank", () => {
		expect(read("one  \t<br>two<br><br><br><br>three &nbsp;<br>   four")).toBe(
			"one\ntwo\n\nthree\n   four",
		);
	});

	it("keeps what only looks like a tag, since it reaches people as text", () => {
		expect(read("1 <> 2")).toBe("1 <> 2");
		expect(read("a < b")).toBe("a < b");
		expect(read("<p>a &lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
			"a <script>alert(1)</script>",
		);
		// A bracket that opens no tag doesn't take the text and tags after it along.
		expect(read("a < b<br>c</p><p>d")).toBe("a < b\nc\nd");
		expect(read("1<2 and 3>2")).toBe("1<2 and 3>2");
		expect(read("<<br>")).toBe("<");
	});

	it("keeps the words of an element that never ends", () => {
		expect(read("<script>still here<style>and here")).toBe("still hereand here");
		expect(read("<script>one</style><script>two")).toBe("onetwo");
	});

	it("goes on after an element that does end", () => {
		expect(read("<style>a</style>b<style>c</style>d<head>e</head>f")).toBe("bdf");
		expect(read("<script>one</style><script>two</script>three")).toBe("three");
	});

	it("takes only those elements for hidden, not ones whose names start the same", () => {
		expect(
			read("<header>one</header><headline>two</headline><head-x>three</head-x><head>not</head>"),
		).toBe("onetwothree");
		expect(read("<style/>one</style>two")).toBe("two");
	});

	// The first five took quadratic time when this was a chain of regular expressions, on mail anyone
	// can send: from 2 to 46 seconds at these sizes, and a mail can be many times the size.
	it.each([
		["opening brackets", "<".repeat(200_000)],
		["line breaks that never close", "<br".repeat(40_000) + " ".repeat(80_000)],
		["spaces with no line end", `${" ".repeat(200_000)}x`],
		["scripts that never end", "<script>".repeat(30_000)],
		["each kind that never ends", "<script><style><head>".repeat(10_000)],
		["runs of spaces", "    x".repeat(40_000)],
		["brackets inside a tag", `<${"a<".repeat(100_000)}>`],
		["ampersands", "&".repeat(200_000)],
		["line ends", "\n".repeat(200_000)],
		["line breaks", "<br>".repeat(50_000)],
	])("takes no time over %s", (_shape, html) => {
		const started = performance.now();
		requestFromEmail({ html, attachments: [] }, "sam@customer.test");
		replyFromEmail({ html });
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

// TRK-79: Track refuses NUL characters and lone surrogates, but mail is filed without them.
describe("emailed text", () => {
	it("is cleaned of NUL characters and lone surrogates, so the request is filed", () => {
		const request = requestFromEmail(
			{
				subject: "Export\0 breaks \ud83d",
				text: "Steps\0 to repeat \udc00: 漢字 🧪",
				attachments: [],
			},
			"sam@customer.test",
		);
		expect(request).toEqual({
			title: "Export breaks �",
			description: "Steps to repeat �: 漢字 🧪\n\nSent by email from <sam@customer.test>.",
		});
		expect(replyFromEmail({ text: "Thanks\0 \ud800!" })).toBe("Thanks �!");
	});

	it("is cut short without splitting an emoji in two", () => {
		const subject = `${"x".repeat(511)}🧪`;
		expect(requestFromEmail({ subject, attachments: [] }, "sam@customer.test").title).toBe(
			"x".repeat(511),
		);
		const text = `${"x".repeat(MAX_EMAILED_TEXT - 1)}🧪 and more`;
		const cut = `${"x".repeat(MAX_EMAILED_TEXT - 1)}…\n\n(Cut short.)`;
		expect(replyFromEmail({ text })).toBe(cut);
		const { description } = requestFromEmail({ text, attachments: [] }, "sam@customer.test");
		expect(description.startsWith(cut)).toBe(true);
	});
});
