import type { Signal } from "@gateweave/track-protocol";
import { expect, it } from "vitest";
import { issueRuns, runExecutorLabel, runWaitLabel } from "./runs";

const signal = (over: Partial<Signal>): Signal => ({
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
	changedAt: 1,
	progress: null,
	startedAt: null,
	endedAt: null,
	executor: null,
	agentName: null,
	waitReason: null,
	waitDetail: null,
	lastContactAt: null,
	...over,
});

it("an issue's runs exclude alerts and other issues' runs", () => {
	const runs = [
		signal({ id: "mine", key: "a" }),
		signal({ id: "other-issue", issueId: "issue-2" }),
		signal({ id: "alert", kind: "alert", state: "open" }),
	];
	expect(issueRuns(runs, "issue-1").map((run) => run.id)).toEqual(["mine"]);
});

it("live runs come before finished ones, newest report first in each", () => {
	const runs = [
		signal({ id: "old-running", state: "running", changedAt: 10 }),
		signal({ id: "new-passed", state: "passed", changedAt: 50 }),
		signal({ id: "queued", state: "queued", changedAt: 20 }),
		signal({ id: "new-running", state: "running", changedAt: 30 }),
		signal({ id: "old-passed", state: "passed", changedAt: 40 }),
	];
	expect(issueRuns(runs, "issue-1").map((run) => run.id)).toEqual([
		"new-running",
		"queued",
		"old-running",
		"new-passed",
		"old-passed",
	]);
});

it("names the executor and agent as one label", () => {
	expect(runExecutorLabel({ executor: "local-runner", agentName: "Codex" })).toBe(
		"Local runner · Codex",
	);
	expect(runExecutorLabel({ executor: "cloud", agentName: null })).toBe("Cloud");
	expect(runExecutorLabel({ executor: null, agentName: "Claude" })).toBe("Claude");
	expect(runExecutorLabel({ executor: null, agentName: null })).toBeNull();
});

it("names what unblocks a waiting run", () => {
	expect(runWaitLabel({ waitReason: "runner-offline", waitDetail: null })).toBe("Runner offline");
	expect(runWaitLabel({ waitReason: "budget-limit", waitDetail: "workspace cap" })).toBe(
		"Budget limit reached · workspace cap",
	);
	// The protocol lets a report carry the detail without the reason; it still explains the wait.
	expect(runWaitLabel({ waitReason: null, waitDetail: "Waiting for operator approval" })).toBe(
		"Waiting for operator approval",
	);
	expect(runWaitLabel({ waitReason: null, waitDetail: null })).toBeNull();
});
