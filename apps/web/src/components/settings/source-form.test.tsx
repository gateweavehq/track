// @vitest-environment happy-dom
import type { Source } from "@gateweave/track-protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SourceForm, shownKey } from "./source-form";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("#/lib/queries", () => ({ useTeams: () => [{ id: "team-1", name: "Ops" }] }));

afterEach(cleanup);

const opened: Source = {
	id: "source-a",
	name: "Guard",
	product: "guard",
	teamId: "team-1",
	lowestSeverity: "high",
	closeWhenCleared: false,
	linkOrigins: ["https://guard.test"],
	assigneeId: null,
	paused: false,
	lastHeardAt: null,
};

it("sends only what the person changed, though another admin changed the source meanwhile", async () => {
	const run = vi.fn(async () => true);
	const { rerender } = render(<SourceForm source={opened} run={run} done={() => {}} />);
	// Saving another source refreshes this one's props while its form stays open.
	rerender(<SourceForm source={{ ...opened, lowestSeverity: "low" }} run={run} done={() => {}} />);
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Guard EU" } });
	fireEvent.submit(screen.getByRole("button", { name: "Save changes" }));
	await vi.waitFor(() => expect(run).toHaveBeenCalled());
	expect(run).toHaveBeenCalledWith({
		kind: "update",
		id: "source-a",
		input: { name: "Guard EU" },
	});
});

it("keeps a key on screen until a new key replaces it", () => {
	const shown = "gws_first";
	// Pausing another source, or making one whose first key failed, brings no new key.
	expect(shownKey(shown, {})).toBe(shown);
	expect(shownKey(shown, { keyMissing: true })).toBe(shown);
	expect(shownKey(shown, { secret: "gws_second" })).toBe("gws_second");
});
