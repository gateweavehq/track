import { describe, expect, it } from "vitest";
import { checkSourceConnectRequest } from "./connect-request";

const TRACK = "https://track.example.org";
const ASKER = "https://guard.example.com";
const fields = {
	product: "guard",
	name: "Guard EU",
	links: ASKER,
	return: `${ASKER}/back`,
	state: "007",
	challenge: "a".repeat(43),
};

function check(overrides: Partial<Record<keyof typeof fields, string | null>> = {}) {
	const params = new URLSearchParams(fields);
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) params.delete(key);
		else params.set(key, value);
	}
	return checkSourceConnectRequest(params.toString(), TRACK);
}

describe("checkSourceConnectRequest", () => {
	it("defaults links to the asker and a blank name to the product", () => {
		expect(check({ name: " ", links: null })).toMatchObject({
			ok: true,
			request: {
				name: "guard",
				origin: ASKER,
				state: "007",
				linkOrigins: [ASKER],
				otherLinkOrigins: [],
			},
		});
		expect(check({ product: "ci", name: null })).toMatchObject({
			ok: true,
			request: { name: "ci" },
		});
	});

	it("compares canonical link origins and warns once for each other address", () => {
		expect(
			check({
				links:
					"https://GUARD.example.com:443/, https://ci.example.org, https://ci.example.org/, http://guard.example.com, https://guard.example.com:444",
			}),
		).toMatchObject({
			ok: true,
			request: {
				linkOrigins: [
					ASKER,
					"https://ci.example.org",
					"http://guard.example.com",
					"https://guard.example.com:444",
				],
				otherLinkOrigins: [
					"https://ci.example.org",
					"http://guard.example.com",
					"https://guard.example.com:444",
				],
			},
		});
	});

	it.each(Object.keys(fields))("refuses two values for %s", (key) => {
		const params = new URLSearchParams(fields);
		params.append(key, params.get(key) ?? "");
		expect(checkSourceConnectRequest(params.toString(), TRACK)).toEqual({
			ok: false,
			problem: expect.stringMatching(/twice/),
		});
	});

	it.each([
		{ product: null },
		{ product: "unknown" },
		{ name: "a".repeat(65) },
		{ name: "one\ntwo" },
		{ name: "a\0b" },
		{ links: "" },
		{ links: Array(6).fill(ASKER).join(",") },
		{ links: "no address" },
		{ links: "https://me:pw@guard.example.com" },
		{ links: `${ASKER}/path` },
		{ links: `${ASKER}/#fragment` },
		{ links: `${ASKER}?q=1` },
		{ links: "ftp://guard.example.com" },
		{ return: null },
		{ return: "/" },
		{ return: "https://user@guard.example.com" },
		{ return: "http://guard.example.com" },
		{ return: `${TRACK}./back` },
		{ return: `https://x.example.com/${"a".repeat(2048)}` },
		{ state: null },
		{ state: "space here" },
		{ state: "x".repeat(201) },
		{ challenge: null },
		{ challenge: "x".repeat(42) },
		{ challenge: "!".repeat(43) },
	])("refuses malformed source settings or proof %j", (overrides) => {
		expect(check(overrides).ok).toBe(false);
	});

	it("allows a 64-character name and an http return address when Track runs on http", () => {
		const params = new URLSearchParams({
			...fields,
			name: "a".repeat(64),
			return: "http://localhost:4720/back",
		});
		expect(checkSourceConnectRequest(params.toString(), "http://localhost:4710").ok).toBe(true);
	});
});
