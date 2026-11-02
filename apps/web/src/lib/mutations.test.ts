import type { MutationInput } from "@gateweave/track-protocol";
import type { SyncClient } from "@gateweave/track-sync-client";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { batchFailure, sendBatch } from "./mutations";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const change = (key: string): { key: string; mutation: MutationInput } => ({
	key,
	mutation: { name: "issue.delete", args: { id: key } },
});

describe("sendBatch", () => {
	it("sends every change at once, and sums up the ones refused partway in one toast", async () => {
		const mutateAll = vi.fn(() => [
			Promise.resolve(3),
			Promise.reject(new Error("Issue not found")),
			Promise.resolve(4),
			Promise.reject(new Error("Only admins can do that")),
		]);
		const client = { mutateAll } as unknown as SyncClient;

		expect(sendBatch(client, ["ENG-1", "ENG-2", "ENG-3", "ENG-4"].map(change))).toBe(true);
		expect(mutateAll).toHaveBeenCalledOnce();
		expect(mutateAll).toHaveBeenCalledWith(expect.any(Array), { report: false });

		await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
		expect(toast.error).toHaveBeenCalledWith("2 of 4 changes were not saved", {
			description: "Left as they were: ENG-2, ENG-4. Issue not found",
		});
	});

	it("says nothing when every change is saved, and reports invalid input at once", async () => {
		vi.mocked(toast.error).mockClear();
		const saved = { mutateAll: () => [Promise.resolve(1)] } as unknown as SyncClient;
		expect(sendBatch(saved, [change("ENG-1")])).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(toast.error).not.toHaveBeenCalled();

		const invalid = {
			mutateAll: () => {
				throw new Error("invalid");
			},
		} as unknown as SyncClient;
		expect(sendBatch(invalid, [change("ENG-1")])).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("That change is not valid");
	});
});

describe("batchFailure", () => {
	it("names up to five issues and counts the rest", () => {
		const keys = ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7"];
		expect(batchFailure(keys, 7)).toEqual({
			title: "None of the 7 changes were saved",
			description: "Left as they were: A-1, A-2, A-3, A-4, A-5 and 2 more.",
		});
		expect(batchFailure(["A-1"], 1, "Gone").title).toBe("Your change was not saved");
	});
});
