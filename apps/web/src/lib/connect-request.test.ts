import { describe, expect, it } from "vitest";
import { checkConnectRequest, parseConnectOrigins, returnAddress } from "./connect-request";
import { safeRedirect } from "./redirect";

const TRACK = "https://track.example.com";
const CHALLENGE = "A".repeat(43);

function request(overrides: Record<string, string | undefined> = {}) {
	const params = new URLSearchParams({
		purpose: "work",
		name: "Coder",
		webhook: "https://agents.example.org/api/triggers/w1/t1",
		events: "issue.updated,comment.created",
		return: "https://agents.example.org/api/track/connected",
		state: "abc_DEF-123",
		challenge: CHALLENGE,
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) params.delete(key);
		else params.set(key, value);
	}
	return `?${params}`;
}

function problem(query: string, track = TRACK) {
	const checked = checkConnectRequest(query, track);
	return checked.ok ? null : checked.problem;
}

describe("checkConnectRequest", () => {
	it("takes a sound request, with its events in Track's order", () => {
		const checked = checkConnectRequest(
			request({ events: "comment.created,issue.updated" }),
			TRACK,
		);
		expect(checked).toMatchObject({
			ok: true,
			request: {
				purpose: "work",
				name: "Coder",
				events: ["issue.updated", "comment.created"],
				origin: "https://agents.example.org",
			},
		});
	});

	it("suggests a name for the purpose when none is given", () => {
		const checked = checkConnectRequest(request({ name: undefined, purpose: "triage" }), TRACK);
		expect(checked).toMatchObject({ ok: true, request: { name: "Triage" } });
	});

	it.each([
		["a webhook that is not https", { webhook: "http://agents.example.org/hook" }],
		["a return address that is not https", { return: "http://agents.example.org/back" }],
		["a script as the return address", { return: "javascript:alert(1)" }],
		["a relative return address", { return: "/back" }],
		["a user name in the webhook", { webhook: "https://me@agents.example.org/hook" }],
		["a password in the return address", { return: "https://me:pw@agents.example.org/back" }],
		["another origin for the return address", { return: "https://other.example.org/back" }],
		["another port for the return address", { return: "https://agents.example.org:8443/back" }],
		[
			"Track's own address",
			{
				webhook: "https://track.example.com/hook",
				return: "https://track.example.com/back",
			},
		],
		[
			"Track's own address with a trailing dot",
			{
				webhook: "https://track.example.com./hook",
				return: "https://track.example.com./back",
			},
		],
		["an event Track does not have", { events: "issue.updated,issue.exploded" }],
		["no events", { events: "" }],
		["an unknown purpose", { purpose: "rule" }],
		["no purpose", { purpose: undefined }],
		["a state with characters an address would change", { state: "a b" }],
		["an empty state", { state: "" }],
		["a state of 201 characters", { state: "a".repeat(201) }],
		["a challenge of the wrong length", { challenge: "A".repeat(42) }],
		["a challenge that is not base64url", { challenge: `${"A".repeat(42)}=` }],
		["a name of 81 characters", { name: "n".repeat(81) }],
		["a name with a control character", { name: "bad\u0007name" }],
	])("refuses %s", (_what, overrides) => {
		expect(problem(request(overrides))).not.toBeNull();
	});

	it("refuses a name given twice", () => {
		expect(problem(`${request()}&state=another`)).not.toBeNull();
	});

	it("allows http only where Track itself is on http", () => {
		const local = request({
			webhook: "http://localhost:4720/hook",
			return: "http://localhost:4720/back",
		});
		expect(problem(local)).not.toBeNull();
		expect(problem(local, "http://localhost:4712")).toBeNull();
		// Track's own port is Track's own address.
		expect(problem(local, "http://localhost:4720")).not.toBeNull();
	});
});

describe("returnAddress", () => {
	it("adds to an address that has a query already, keeping it", () => {
		const url = new URL(
			returnAddress("https://agents.example.org/back?x=1&y=a%20b#top", { code: "c", state: "s" }),
		);
		expect(url.origin).toBe("https://agents.example.org");
		expect([...url.searchParams]).toEqual([
			["x", "1"],
			["y", "a b"],
			["code", "c"],
			["state", "s"],
		]);
		expect(url.hash).toBe("#top");
	});

	it("leaves no second code or state for the receiver to choose between", () => {
		const url = new URL(
			returnAddress("https://agents.example.org/back?code=old&state=old", {
				error: "denied",
				state: "s",
			}),
		);
		expect(url.searchParams.getAll("state")).toEqual(["s"]);
		expect(url.searchParams.get("error")).toBe("denied");
		// A code the address already had is not touched by an answer that has none.
		expect(url.searchParams.get("code")).toBe("old");
	});
});

describe("parseConnectOrigins", () => {
	it("reads origins, however they are written, and drops what is not one", () => {
		expect(
			[
				...parseConnectOrigins(
					" https://agents.example.org/path , http://localhost:4720,nonsense,,ftp://x.test",
				),
			].sort(),
		).toEqual(["http://localhost:4720", "https://agents.example.org"]);
		expect(parseConnectOrigins(undefined).size).toBe(0);
	});
});

describe("signing in on the way to the page", () => {
	it("keeps the whole query, and refuses to be sent elsewhere", () => {
		const here = `/connect/agent${request()}`;
		expect(safeRedirect(here)).toBe(here);
		expect(safeRedirect(`//agents.example.org${request()}`)).toBeNull();
		expect(safeRedirect(`https://agents.example.org/connect/agent${request()}`)).toBeNull();
	});
});
