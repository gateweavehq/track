import type { Signal, SyncedIssue, Team } from "@gateweave/track-protocol";
import { expect, it } from "vitest";
import { overviewExecutors, overviewRuns, RECENTLY_FAILED_WITHIN } from "./runs-overview";

const NOW = 1_800_000_000_000;

const signal = (over: Partial<Signal>): Signal =>
	({
		id: "s",
		sourceId: "source",
		kind: "run",
		key: "fix-eng-1",
		type: null,
		subject: null,
		severity: "unknown",
		state: "running",
		url: null,
		issueId: "issue-1",
		reopens: 0,
		firstAt: 1,
		changedAt: NOW,
		progress: null,
		startedAt: null,
		endedAt: null,
		executor: null,
		agentName: null,
		waitReason: null,
		waitDetail: null,
		lastContactAt: null,
		attemptNo: null,
		...over,
	}) as Signal;

const issues = new Map<string, Pick<SyncedIssue, "teamId" | "number" | "title">>([
	["issue-1", { teamId: "team-1", number: 12, title: "Fix the thing" }],
	["issue-2", { teamId: "team-1", number: 13, title: "Another" }],
]);
const teams = new Map<string, Pick<Team, "key">>([["team-1", { key: "ENG" }]]);

it("groups running, queued and recently failed runs, newest report first in each", () => {
	const rows = overviewRuns(
		[
			signal({ id: "running-old", changedAt: NOW - 100 }),
			signal({ id: "running-new", changedAt: NOW - 10 }),
			signal({ id: "queued", state: "queued", changedAt: NOW - 20 }),
			signal({
				id: "failed-recent",
				state: "failed",
				endedAt: NOW - 60_000,
				changedAt: NOW - 60_000,
			}),
			signal({
				id: "failed-old",
				state: "failed",
				endedAt: NOW - RECENTLY_FAILED_WITHIN - 1,
				changedAt: NOW - RECENTLY_FAILED_WITHIN - 1,
			}),
			signal({ id: "passed", state: "passed", endedAt: NOW - 60_000 }),
			signal({ id: "cancelled", state: "cancelled", endedAt: NOW - 60_000 }),
		],
		issues,
		teams,
		NOW,
	);
	expect(rows.running.map((row) => row.run.id)).toEqual(["running-new", "running-old"]);
	expect(rows.queued.map((row) => row.run.id)).toEqual(["queued"]);
	expect(rows.failed.map((row) => row.run.id)).toEqual(["failed-recent"]);
});

it("leaves out alerts and unbound runs", () => {
	const rows = overviewRuns(
		[
			signal({ id: "alert", kind: "alert", state: "open" }),
			signal({ id: "unbound", issueId: null }),
			signal({ id: "bound" }),
		],
		issues,
		teams,
		NOW,
	);
	expect(rows.running.map((row) => row.run.id)).toEqual(["bound"]);
});

it("names the issue by its team key and number, or null when the replica lacks it", () => {
	const rows = overviewRuns(
		[signal({ id: "known" }), signal({ id: "unknown", issueId: "issue-missing" })],
		issues,
		teams,
		NOW,
	);
	const known = rows.running.find((row) => row.run.id === "known");
	expect(known?.issueKey).toBe("ENG-12");
	expect(known?.issueTitle).toBe("Fix the thing");
	expect(rows.running.find((row) => row.run.id === "unknown")?.issueKey).toBeNull();
});

it("filters by executor", () => {
	const rows = overviewRuns(
		[
			signal({ id: "hosted", executor: "agents-hosted" }),
			signal({ id: "local", executor: "local-runner" }),
			signal({ id: "none", executor: null }),
		],
		issues,
		teams,
		NOW,
		"local-runner",
	);
	expect(rows.running.map((row) => row.run.id)).toEqual(["local"]);
});

it("lists the executors in use, in the protocol's order", () => {
	expect(
		overviewExecutors([
			signal({ executor: "cloud" }),
			signal({ executor: "agents-hosted" }),
			signal({ executor: null }),
			signal({ executor: "cloud" }),
		]),
	).toEqual(["agents-hosted", "cloud"]);
});
