// @vitest-environment happy-dom
import type { Signal } from "@gateweave/track-protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const signals = new Map<string, Signal>();

vi.mock("#/lib/queries", () => ({
	useSignals: () => signals,
	useIssuesById: () =>
		new Map([["issue-1", { teamId: "team-1", number: 12, title: "Fix the thing" }]]),
	useTeamsById: () => new Map([["team-1", { key: "ENG" }]]),
}));
vi.mock("#/components/workspace/context", () => ({ useWorkspace: () => ({ slug: "ws" }) }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/ws/issue/ENG-12">{children}</a>,
}));

const { RunsOverviewPage } = await import("./runs-overview-page");

afterEach(cleanup);

function filterOf(
	page: ReturnType<typeof render>,
	label = "Filter by executor",
): HTMLSelectElement {
	const select = page.getByLabelText(label);
	if (!(select instanceof HTMLSelectElement)) throw new Error("The filter is not a select");
	return select;
}

const local = {
	id: "run-1",
	sourceId: "source",
	kind: "run",
	key: "fix-eng-12",
	type: null,
	subject: null,
	severity: "unknown",
	state: "running",
	url: null,
	issueId: "issue-1",
	reopens: 0,
	firstAt: 1,
	changedAt: Date.now(),
	progress: "Running the checks",
	startedAt: null,
	endedAt: null,
	executor: "local-runner",
	agentName: null,
	waitReason: null,
	waitDetail: null,
	lastContactAt: null,
	attemptNo: null,
	repository: null,
} as Signal;

it("WEB-84: keeps the executor the address names, even with none of its runs on the page", () => {
	signals.clear();
	signals.set(local.id, local);
	const change = vi.fn();
	const page = render(<RunsOverviewPage filter={{ executor: "cloud" }} onFilterChange={change} />);
	// The local runner's run is not shown under Cloud, and the filter still says Cloud.
	expect(page.queryByText("Running the checks")).toBeNull();
	expect(filterOf(page).value).toBe("cloud");
	expect(page.getByRole("heading", { name: "No Cloud runs" })).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Show all runs" }));
	expect(change).toHaveBeenCalledWith({});
});

it("WEB-84: without a filter, the page lists every run it shows", () => {
	signals.clear();
	signals.set(local.id, local);
	const page = render(<RunsOverviewPage filter={{}} onFilterChange={vi.fn()} />);
	expect(page.getByText("Running the checks")).toBeTruthy();
	expect([...filterOf(page).options].map((option) => option.textContent)).toEqual([
		"All executors",
		"Local runner",
	]);
	// No run on the page has a repository, so there is nothing to choose between.
	expect(page.queryByLabelText("Filter by repository")).toBeNull();
});

it("WEB-84: narrows to a repository, keeping the executor already chosen", () => {
	signals.clear();
	const site = { ...local, id: "site", repository: "acme/site", progress: "Building the site" };
	const docs = { ...local, id: "docs", repository: "acme/docs", progress: "Building the docs" };
	for (const run of [site, docs]) signals.set(run.id, run);
	const change = vi.fn();
	const page = render(
		<RunsOverviewPage filter={{ executor: "local-runner" }} onFilterChange={change} />,
	);
	const repositories = filterOf(page, "Filter by repository");
	expect([...repositories.options].map((option) => option.textContent)).toEqual([
		"All repositories",
		"acme/docs",
		"acme/site",
	]);
	fireEvent.change(repositories, { target: { value: "acme/site" } });
	expect(change).toHaveBeenCalledWith({ executor: "local-runner", repository: "acme/site" });
	page.rerender(
		<RunsOverviewPage
			filter={{ executor: "local-runner", repository: "acme/site" }}
			onFilterChange={change}
		/>,
	);
	expect(page.getByText("Building the site")).toBeTruthy();
	expect(page.queryByText("Building the docs")).toBeNull();
});

it("WEB-84: keeps a repository the address names after its runs leave, and offers to show all", () => {
	signals.clear();
	signals.set(local.id, { ...local, repository: "acme/site" });
	const change = vi.fn();
	const page = render(
		<RunsOverviewPage filter={{ repository: "acme/docs" }} onFilterChange={change} />,
	);
	expect(filterOf(page, "Filter by repository").value).toBe("acme/docs");
	expect(page.queryByText("Running the checks")).toBeNull();
	expect(page.getByRole("heading", { name: "No runs in acme/docs" })).toBeTruthy();
	fireEvent.click(page.getByRole("button", { name: "Show all runs" }));
	expect(change).toHaveBeenCalledWith({});
});
