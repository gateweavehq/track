import { defaultStatuses, type MutationInput, type Snapshot } from "@gateweave/track-protocol";
import { type MutationError, SyncClient, type Transport } from "@gateweave/track-sync-client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchFailure, changeName, rejectionReporter, send, sendBatch } from "./mutations";

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

describe("changeName", () => {
	const keys = new Map([["i1", "ENG-1"]]);
	const keyOf = (id: string) => keys.get(id);

	it("names an issue that is still here by its key", () => {
		expect(changeName({ name: "issue.delete", args: { id: "i1" } }, keyOf)).toBe("ENG-1");
		expect(
			changeName({ name: "comment.create", args: { id: "c1", issueId: "i1", body: "Hi" } }, keyOf),
		).toBe("ENG-1");
	});

	it("keeps refusals of issues that are gone apart, by what changed and which id", () => {
		vi.useFakeTimers();
		const report = rejectionReporter((error) => changeName(error.mutation, keyOf));
		for (const id of ["gone-1", "gone-2"]) {
			report({
				message: "Issue not found",
				mutation: { name: "issue.update", args: { id, baseVersion: 1, patch: {} } },
			} as unknown as MutationError);
		}
		vi.advanceTimersByTime(300);
		expect(toast.error).toHaveBeenCalledWith("2 changes were not saved", {
			description: "issue.update gone-1, issue.update gone-2: Issue not found.",
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

// TRK-79: the server refuses NUL characters and lone surrogates. Text pasted into an editor can
// carry them unseen, so it is cleaned on its way to the server rather than refused.
describe("send", () => {
	const snapshot: Snapshot = {
		version: 1,
		teams: [
			{
				id: "t1",
				key: "ENG",
				name: "Engineering",
				cycles: null,
				archiveAfterMonths: null,
				closeAfterMonths: null,
				intakeFormKey: null,
				intakeEmailKey: null,
				intakeFollowers: [],
				createdAt: 1,
				updatedAt: 1,
			},
		],
		statuses: defaultStatuses("t1", 1),
		issues: [],
		labels: [],
		projects: [],
		cycles: [],
		comments: [],
		activities: [],
		proposals: [],
		relations: [],
		projectUpdates: [],
		views: [],
		templates: [],
		members: [],
		subscriptions: [],
		inbox: [],
		pullRequests: [],
	};
	/** Serves a snapshot but never connects, so what was sent stays pending, to look at. */
	const offline: Transport = {
		snapshot: async () => snapshot,
		probe: async () => {},
		connect: () => ({ send() {}, close() {} }),
	};

	it("cleans pasted text of NUL characters and lone surrogates", async () => {
		const client = new SyncClient({ userId: "alice", transport: offline });
		try {
			await vi.waitFor(() => expect(client.getStatus().loaded).toBe(true));
			const pasted = {
				title: "Crash\0 on save \ud83d",
				description: "Pasted from the log:\0 漢字 🐛 \udc00",
			};
			const issue = { id: "i1", teamId: "t1", sortOrder: "a0", ...pasted };
			expect(send(client, { name: "issue.create", args: issue })).toBe(true);
			const comment = { id: "c1", issueId: "i1", body: "\0Same\ud800" };
			expect(send(client, { name: "comment.create", args: comment })).toBe(true);

			expect(toast.error).not.toHaveBeenCalled();
			expect(client.getState().issues.get("i1")).toMatchObject({
				title: "Crash on save \ufffd",
				description: "Pasted from the log: 漢字 🐛 \ufffd",
			});
			expect(client.getState().comments.get("c1")?.body).toBe("Same\ufffd");
			expect(client.getStatus().pending).toBe(2);
		} finally {
			await client.close();
		}
	});
});
