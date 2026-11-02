import type { MutationInput } from "@gateweave/track-protocol";
import type { MutationError, SyncClient } from "@gateweave/track-sync-client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchFailure, rejectionReporter, send, sendBatch } from "./mutations";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
	vi.mocked(toast.error).mockClear();
	vi.useRealTimers();
});

const change = (key: string): { key: string; mutation: MutationInput } => ({
	key,
	mutation: { name: "issue.delete", args: { id: key } },
});

describe("sendBatch", () => {
	it("sends every change at once, and sums up the ones refused partway by reason", async () => {
		const mutateAll = vi.fn(() => [
			Promise.resolve(3),
			Promise.reject(new Error("Issue not found")),
			Promise.resolve(4),
			Promise.reject(new Error("only admins can do that")),
			Promise.reject(new Error("Issue not found")),
		]);
		const client = { mutateAll } as unknown as SyncClient;

		const keys = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"];
		expect(sendBatch(client, keys.map(change))).toBe(true);
		expect(mutateAll).toHaveBeenCalledOnce();
		expect(mutateAll).toHaveBeenCalledWith(expect.any(Array), { report: false });

		await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
		expect(toast.error).toHaveBeenCalledWith("3 of 5 changes were not saved", {
			description: "ENG-2, ENG-5: Issue not found. ENG-4: Only admins can do that.",
		});
	});

	it("says nothing when every change is saved", async () => {
		const saved = { mutateAll: () => [Promise.resolve(1)] } as unknown as SyncClient;
		expect(sendBatch(saved, [change("ENG-1")])).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("tells invalid input from a tab that has stopped syncing", () => {
		const invalid = {
			mutateAll: () => {
				throw Object.assign(new Error("[]"), { name: "ZodError" });
			},
		} as unknown as SyncClient;
		expect(sendBatch(invalid, [change("ENG-1")])).toBe(false);
		expect(toast.error).toHaveBeenLastCalledWith("That change is not valid");

		const closed = {
			mutate: () => {
				throw new Error("This SyncClient is closed");
			},
		} as unknown as SyncClient;
		expect(send(closed, change("ENG-1").mutation)).toBe(false);
		expect(toast.error).toHaveBeenLastCalledWith("This tab has stopped syncing", {
			description: "Reload the page to go on.",
		});
	});
});

describe("rejectionReporter", () => {
	const refusal = (id: string, message: string) =>
		({ message, mutation: { name: "issue.delete", args: { id } } }) as unknown as MutationError;

	it("sums up refusals that arrive together, as after a reload, in one toast", () => {
		vi.useFakeTimers();
		const report = rejectionReporter((error) => (error.mutation.args as { id: string }).id);
		for (let n = 1; n <= 500; n++) report(refusal(`ENG-${n}`, "Issue not found"));
		expect(toast.error).not.toHaveBeenCalled();
		vi.advanceTimersByTime(300);
		expect(toast.error).toHaveBeenCalledOnce();
		expect(toast.error).toHaveBeenCalledWith("500 changes were not saved", {
			description: "ENG-1, ENG-2, ENG-3, ENG-4, ENG-5 and 495 more: Issue not found.",
		});

		// One on its own reads as it always did.
		report(refusal("ENG-9", "Issue not found"));
		vi.advanceTimersByTime(300);
		expect(toast.error).toHaveBeenLastCalledWith("Your change was not saved", {
			description: "Issue not found.",
		});
	});
});

describe("batchFailure", () => {
	it("lists three reasons, and counts the issues refused for any other", () => {
		const failures = ["a", "b", "c", "d", "e"].map((reason, n) => ({ key: `A-${n}`, reason }));
		expect(batchFailure(failures, 5)).toEqual({
			title: "None of the 5 changes were saved",
			description: "A-0: A. A-1: B. A-2: C. 2 more for other reasons.",
		});
		expect(batchFailure([{ key: "A-1", reason: "Gone." }], 1).title).toBe(
			"Your change was not saved",
		);
	});
});
