// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineError } from "#/lib/offline";
import { RouteError } from "./route-error";

// What a page shows when it fails to load (TRK-143). It used to show the error's message, which
// comes from the server: a failed database query's was its statement and every value it was given.

const invalidate = vi.fn();

vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

afterEach(() => {
	cleanup();
	invalidate.mockClear();
});

function shown(error: Error) {
	const { container, getByRole } = render(<RouteError error={error} reset={() => {}} />);
	return { text: container.textContent ?? "", retry: getByRole("button", { name: "Try again" }) };
}

describe("a page that failed to load", () => {
	it("shows none of the error's message, whatever it holds", () => {
		const { text } = shown(
			new Error(
				'Failed query: select "id" from "session" where "session"."token" = ?\nparams: a-token',
			),
		);

		expect(text).toContain("Something went wrong");
		expect(text).toContain("This page could not be loaded.");
		expect(text).not.toContain("Failed query");
		expect(text).not.toContain("session");
		expect(text).not.toContain("a-token");
		expect(text).not.toContain("reference");
	});

	it("shows the reference of a failed database query, to find it in the log by", () => {
		const { text } = shown(new Error("A database query failed (reference 1a2b3c4d)"));

		expect(text).toContain("under the reference 1a2b3c4d.");
		expect(text).not.toContain("A database query failed");
	});

	it("finds the reference in what the error was caused by", () => {
		const cause = new Error("A database query failed (reference 0f9e8d7c)");
		const { text } = shown(new Error("Failed to get session", { cause }));

		expect(text).toContain("under the reference 0f9e8d7c.");
		expect(text).not.toContain("Failed to get session");
	});

	it("loads the page again when asked", () => {
		shown(new Error("anything")).retry.click();

		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("still says so when the server could not be reached, which is not a failure of the page", () => {
		const { text } = shown(new OfflineError());

		expect(text).toContain("You're offline");
		expect(text).toContain("This page needs a connection.");
		expect(text).not.toContain("Something went wrong");
	});
});
