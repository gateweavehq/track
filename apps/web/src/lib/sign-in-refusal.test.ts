import { describe, expect, it } from "vitest";
import { signInRefusal } from "./sign-in-refusal";

describe("signInRefusal", () => {
	it("says nothing when nothing was refused", () => {
		expect(signInRefusal(undefined)).toBeNull();
		expect(signInRefusal("")).toBeNull();
	});

	it("explains an address that cannot be linked to its account", () => {
		expect(signInRefusal("account_not_linked")).toContain("already has an account");
	});

	it("gives a closed server's words, the same for every address", () => {
		expect(signInRefusal("SIGN_UP_CLOSED")).toBe(
			"This server takes new accounts by invitation. Ask whoever runs it to invite you.",
		);
	});

	it("says a return that no longer matches took too long or was started twice", () => {
		const message = signInRefusal("state_mismatch");
		expect(message).toBe("Signing in took too long or was started twice. Try again.");
		// The password had nothing to do with it.
		expect(message).not.toContain("password");
	});

	it("tells someone an assistant sent that the assistant is what cannot connect", () => {
		for (const code of [
			"invalid_client",
			"client_disabled",
			"unauthorized_client",
			"invalid_redirect",
		]) {
			expect(signInRefusal(code)).toContain("cannot connect to this server");
		}
	});

	it("has one sentence for the codes it does not know", () => {
		const message = signInRefusal("state_not_found");
		expect(message).toContain("did not work");
		for (const code of ["internal_server_error", "invalid_callback_request", "no_code", "x"]) {
			expect(signInRefusal(code)).toBe(message);
		}
	});

	it("answers anything else in its own words, whatever the link says", () => {
		const message = signInRefusal("<script>alert(1)</script>");
		expect(message).toContain("did not work");
		expect(message).not.toContain("script");
		// Not the prototype's, which a lookup on a plain object would find.
		expect(signInRefusal("constructor")).toBe(message);
	});
});
