// @vitest-environment happy-dom
import { deleteIdbReplica } from "@gateweave/track-sync-client";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncGate } from "./sync-status";

const close = vi.fn(async () => {});
const defaultPending = [
	{ mutation: { name: "issue.create", args: { title: "First issue" } } },
	{ mutation: { name: "team.create", args: { key: "ENG" } } },
];
let pending = defaultPending;
const getPending = vi.fn(() => pending);
afterEach(() => {
	cleanup();
	pending = defaultPending;
	vi.clearAllMocks();
});

vi.mock("@gateweave/track-sync-client", async (original) => ({
	...(await original<typeof import("@gateweave/track-sync-client")>()),
	deleteIdbReplica: vi.fn(async () => {}),
}));
vi.mock("@gateweave/track-sync-client/react", async (original) => ({
	...(await original<typeof import("@gateweave/track-sync-client/react")>()),
	useSyncStatus: () => ({ connection: "unreadable", loaded: true, pending: getPending().length }),
	useSyncClient: () => ({ close, getPending }),
}));

it("shows readable data and confirms discarding the local replica", async () => {
	const page = render(<SyncGate storageKey="user:workspace">Readable snapshot</SyncGate>);
	expect(page.getByText("Readable snapshot")).toBeTruthy();
	expect(page.getByText("This device's local copy cannot be read")).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	expect(
		page.getByText("2 changes that have not reached the server will be lost:", { exact: false }),
	).toBeTruthy();
	expect(page.getByText("issue.create (First issue)", { exact: false })).toBeTruthy();
	expect(page.getByText("team.create (ENG)", { exact: false })).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	expect(page.getByText(/Once deletion starts, closing this dialog cannot stop it/)).toBeTruthy();
	await waitFor(() =>
		expect(deleteIdbReplica).toHaveBeenCalledWith("user:workspace", expect.any(Object)),
	);
	expect(close).toHaveBeenCalledOnce();
});

it("says when no readable unsent changes can be listed", () => {
	pending = [];
	const page = render(<SyncGate storageKey="empty">Snapshot</SyncGate>);
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	expect(
		page.getByText(/This version could not list unsent changes/, {
			exact: false,
		}),
	).toBeTruthy();
});

it("reports a blocked discard and lets cancel dismiss the pending dialog", async () => {
	const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
	let blocked = () => {};
	let finish = () => {};
	vi.mocked(deleteIdbReplica).mockImplementationOnce(async (_key, options) => {
		blocked = options?.onBlocked ?? blocked;
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const page = render(<SyncGate storageKey="blocked">Snapshot</SyncGate>);
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	await waitFor(() => expect(deleteIdbReplica).toHaveBeenCalled());
	blocked();
	await waitFor(() => expect(page.getByRole("alert").textContent).toContain("Another tab"));
	fireEvent.click(page.getByRole("button", { name: "Stop waiting" }));
	expect(page.queryByRole("dialog")).toBeNull();
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	expect(page.getByRole("dialog")).toBeTruthy();
	finish();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(reload).not.toHaveBeenCalled();
	expect(page.getByRole("dialog")).toBeTruthy();
	reload.mockRestore();
});

it("explains when the discard wait times out", async () => {
	vi.mocked(deleteIdbReplica).mockRejectedValueOnce(new Error("Discard timed out"));
	const page = render(<SyncGate storageKey="timed-out">Snapshot</SyncGate>);
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	await waitFor(() => expect(page.getByRole("alert").textContent).toContain("10 seconds"));
	expect(page.getByRole("alert").textContent).toContain("deletion may still finish");
});

it("reports a failed delete without claiming it timed out", async () => {
	vi.mocked(deleteIdbReplica).mockRejectedValueOnce(new Error("Delete failed"));
	const page = render(<SyncGate storageKey="failed">Snapshot</SyncGate>);
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	await waitFor(() =>
		expect(page.getByRole("alert").textContent).toContain("could not be deleted"),
	);
	expect(page.getByRole("alert").textContent).not.toContain("10 seconds");
});
