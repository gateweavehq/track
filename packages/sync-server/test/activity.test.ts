import type { ActivityChange } from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { ACTIVITY_MERGE_WINDOW_MS, mergeActivity } from "../src/activity";

const issue = { creatorId: "user-creator", createdAt: 1_000_000 };
const later = issue.createdAt + ACTIVITY_MERGE_WINDOW_MS + 1;

function latest(
	change: ActivityChange,
	actorId = "user-a",
	updatedAt = later,
	proposedBy: string | null = null,
) {
	return { actorId, change, updatedAt, proposedBy };
}

describe("mergeActivity", () => {
	it("leaves out the creator writing the title and description, only at first", () => {
		const title: ActivityChange = { type: "title", from: "A", to: "B" };

		expect(mergeActivity(undefined, issue, "user-creator", title, issue.createdAt + 10)).toEqual({
			kind: "skip",
		});
		expect(mergeActivity(undefined, issue, "user-creator", { type: "description" }, later)).toEqual(
			{ kind: "append" },
		);
		expect(mergeActivity(undefined, issue, "user-other", title, issue.createdAt + 10)).toEqual({
			kind: "append",
		});
		expect(
			mergeActivity(
				undefined,
				issue,
				"user-creator",
				{ type: "status", from: "backlog", to: "todo" },
				issue.createdAt + 10,
			),
		).toEqual({ kind: "append" });
	});

	it("merges a field's changes into one entry that ends at the latest value", () => {
		const status = latest({ type: "status", from: "backlog", to: "todo" });

		expect(
			mergeActivity(status, issue, "user-a", { type: "status", from: "todo", to: "done" }, later),
		).toEqual({ kind: "replace", change: { type: "status", from: "backlog", to: "done" } });
		expect(
			mergeActivity(
				status,
				issue,
				"user-a",
				{ type: "status", from: "todo", to: "backlog" },
				later,
			),
		).toEqual({ kind: "remove" });
	});

	it("starts a new entry for another person, another field or after the window", () => {
		const status = latest({ type: "status", from: "backlog", to: "todo" });
		const next: ActivityChange = { type: "status", from: "todo", to: "done" };

		expect(mergeActivity(status, issue, "user-b", next, later)).toEqual({ kind: "append" });
		expect(
			mergeActivity(status, issue, "user-a", { type: "priority", from: 0, to: 1 }, later),
		).toEqual({ kind: "append" });
		expect(mergeActivity(status, issue, "user-a", next, later + ACTIVITY_MERGE_WINDOW_MS)).toEqual({
			kind: "replace",
			change: { type: "status", from: "backlog", to: "done" },
		});
		expect(
			mergeActivity(status, issue, "user-a", next, later + ACTIVITY_MERGE_WINDOW_MS + 1),
		).toEqual({ kind: "append" });
	});

	it("treats labels as sets and description edits as one", () => {
		const added = latest({ type: "label", labelId: "label-bug", added: true });

		expect(
			mergeActivity(
				added,
				issue,
				"user-a",
				{ type: "label", labelId: "label-bug", added: false },
				later,
			),
		).toEqual({ kind: "remove" });
		expect(
			mergeActivity(
				added,
				issue,
				"user-a",
				{ type: "label", labelId: "label-docs", added: true },
				later,
			),
		).toEqual({ kind: "append" });
		expect(
			mergeActivity(
				latest({ type: "description" }),
				issue,
				"user-a",
				{ type: "description" },
				later,
			),
		).toEqual({ kind: "skip" });
	});

	it("keeps an accepted proposal in an entry of its own, so the history says whose idea it was", () => {
		const next: ActivityChange = { type: "status", from: "todo", to: "done" };
		const own = latest({ type: "status", from: "backlog", to: "todo" });
		const accepted = latest(
			{ type: "status", from: "backlog", to: "todo" },
			"user-a",
			later,
			"agent",
		);

		expect(mergeActivity(own, issue, "user-a", next, later, "agent")).toEqual({ kind: "append" });
		expect(mergeActivity(accepted, issue, "user-a", next, later)).toEqual({ kind: "append" });
		// Even a proposal that puts back what the person just changed leaves both in the history.
		const back: ActivityChange = { type: "status", from: "todo", to: "backlog" };
		expect(mergeActivity(own, issue, "user-a", back, later, "agent")).toEqual({ kind: "append" });
		// And an issue's first entries are kept when they were an agent's idea.
		const title: ActivityChange = { type: "title", from: "A", to: "B" };
		expect(
			mergeActivity(undefined, issue, "user-creator", title, issue.createdAt + 10, "agent"),
		).toEqual({ kind: "append" });
	});
});
