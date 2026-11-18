// @vitest-environment happy-dom
import { deleteIdbReplica } from "@gateweave/track-sync-client";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SyncGate } from "./sync-status";

const close = vi.fn(async () => {});

vi.mock("@gateweave/track-sync-client", async (original) => ({
	...(await original<typeof import("@gateweave/track-sync-client")>()),
	deleteIdbReplica: vi.fn(async () => {}),
}));
vi.mock("@gateweave/track-sync-client/react", async (original) => ({
	...(await original<typeof import("@gateweave/track-sync-client/react")>()),
	useSyncStatus: () => ({ connection: "unreadable", loaded: true, pending: 0 }),
	useSyncClient: () => ({ close }),
}));

it("shows readable data and confirms discarding the local replica", async () => {
	const page = render(<SyncGate storageKey="user:workspace">Readable snapshot</SyncGate>);
	expect(page.getByText("Readable snapshot")).toBeTruthy();
	expect(page.getByText("This device's local copy cannot be read")).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	expect(
		page.getByText("Changes that have not reached the server will be lost.", { exact: false }),
	).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Discard local copy" }));
	await waitFor(() => expect(deleteIdbReplica).toHaveBeenCalledWith("user:workspace"));
	expect(close).toHaveBeenCalledOnce();
});
