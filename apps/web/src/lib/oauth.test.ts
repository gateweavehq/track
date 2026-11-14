import { describe, expect, it } from "vitest";
import { destination } from "./oauth";

describe("destination", () => {
	it("calls a loopback address an app on this computer, whatever its port or path", () => {
		for (const uri of [
			"http://127.0.0.1:47199/callback",
			"http://localhost:3000/cb",
			"http://[::1]:8080/",
		]) {
			expect(destination(uri)).toBe("an app on this computer");
		}
	});

	it("names the host of any other web address, and the scheme of an app's own", () => {
		expect(destination("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
		expect(destination("https://app.example.com:8443/cb")).toBe("app.example.com:8443");
		expect(destination("cursor://anysphere.cursor-retrieval/oauth")).toBe("cursor:");
	});

	it("falls back to the app when there is no address a person can read", () => {
		expect(destination(null)).toBe("the app");
		expect(destination(undefined)).toBe("the app");
		expect(destination("not a url")).toBe("the app");
	});
});
