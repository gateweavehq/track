// @vitest-environment happy-dom
import type { Signal } from "@gateweave/track-protocol";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import type { RunSignal } from "#/lib/runs";
import { RunList } from "./runs";

afterEach(cleanup);

const run = (over: Partial<RunSignal>): RunSignal =>
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
	}) as RunSignal;

it("renders nothing without runs", () => {
	expect(renderToStaticMarkup(<RunList runs={[]} />)).toBe("");
});

it("shows the live run's executor, progress, contact and link, and keeps history collapsed", () => {
	const html = renderToStaticMarkup(
		<RunList
			runs={[
				run({
					id: "live",
					state: "running",
					executor: "local-runner",
					agentName: "Codex",
					progress: "3 of 5 checks",
					startedAt: Date.now() - 5 * 60_000,
					lastContactAt: Date.now() - 30_000,
					url: "https://ci.example.com/build/7",
				}),
				run({ id: "old-1", state: "failed", key: "fix-eng-0", changedAt: 2 }),
				run({ id: "old-2", state: "passed", key: "fix-eng-00", changedAt: 1 }),
			]}
		/>,
	);
	expect(html).toContain("Runs");
	expect(html).toContain("fix-eng-1");
	expect(html).toContain("Local runner · Codex");
	expect(html).toContain("3 of 5 checks");
	expect(html).toContain("Started");
	expect(html).toContain("Last contact");
	expect(html).toContain('href="https://ci.example.com/build/7"');
	// The latest finished run shows beside the live one; the older one collapses under a toggle.
	expect(html).toContain("1 earlier run");
	expect(html).toContain("fix-eng-0");
	expect(html).toContain("fix-eng-00");
});

it("says what unblocks a waiting run", () => {
	const page = render(
		<RunList
			runs={[
				run({
					state: "queued",
					waitReason: "runner-offline",
					waitDetail: "the machine slept",
				}),
			]}
		/>,
	);
	expect(page.getByText("Runner offline · the machine slept")).toBeTruthy();
});
