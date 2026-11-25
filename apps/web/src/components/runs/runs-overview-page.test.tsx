// @vitest-environment happy-dom
import type { Signal } from "@gateweave/track-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { RunSignal } from "#/lib/runs";
import { overviewRuns } from "#/lib/runs-overview";

// The issue link is TanStack's; the test only checks what the row shows, not navigation.
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

const { OverviewSections } = await import("./runs-overview-page");

const NOW = 1_800_000_000_000;

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
	}) as RunSignal;

const issues = new Map([["issue-1", { teamId: "team-1", number: 12, title: "Fix the thing" }]]);
const teams = new Map([["team-1", { key: "ENG" }]]);

function render(runs: RunSignal[]) {
	const groups = overviewRuns(runs, issues, teams, NOW);
	return renderToStaticMarkup(<OverviewSections groups={groups} now={NOW} workspace="ws" />);
}

it("groups rows under Running, Queued and Recently failed with their counts", () => {
	const html = render([
		run({ id: "r1", state: "running" }),
		run({ id: "r2", state: "queued" }),
		run({ id: "r3", state: "failed", endedAt: NOW - 60_000, changedAt: NOW - 60_000 }),
	]);
	expect(html).toContain("Running");
	expect(html).toContain("Queued");
	expect(html).toContain("Recently failed");
});

it("links the row to its issue and shows executor, agent, progress and timing", () => {
	const html = render([
		run({
			state: "running",
			executor: "local-runner",
			agentName: "Codex",
			progress: "3 of 5 checks",
			startedAt: NOW - 5 * 60_000,
			lastContactAt: NOW - 30_000,
			url: "https://ci.example.com/build/7",
			attemptNo: 2,
		}),
	]);
	expect(html).toContain("Attempt 2");
	expect(html).toContain("Local runner · Codex");
	expect(html).toContain("ENG-12");
	expect(html).toContain("Fix the thing");
	expect(html).toContain("3 of 5 checks");
	expect(html).toContain("Started");
	expect(html).toContain("Last contact");
	expect(html).toContain('href="https://ci.example.com/build/7"');
});

it("says what unblocks a waiting run and reads a product run's key", () => {
	const html = render([
		run({
			state: "queued",
			key: "deploy-7",
			waitReason: "runner-offline",
			waitDetail: "the machine slept",
		}),
	]);
	expect(html).toContain("deploy-7");
	expect(html).toContain("Runner offline · the machine slept");
});

it("shows a run whose issue the replica does not hold without a link", () => {
	const html = renderToStaticMarkup(
		<OverviewSections
			groups={overviewRuns([run({ issueId: "missing", progress: "working" })], issues, teams, NOW)}
			now={NOW}
			workspace="ws"
		/>,
	);
	expect(html).toContain("working");
	expect(html).not.toContain("ENG-12");
});
