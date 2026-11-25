// @vitest-environment happy-dom
import type { ActiveIssue, Source } from "@gateweave/track-protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pastTense, RunnerApproval } from "./runner-approval";

const sources: Source[] = [];

vi.mock("#/lib/queries", () => ({
	useRunnerSources: () => sources,
	useSource: (id: string) => sources.find((source) => source.id === id),
}));
vi.mock("#/components/workspace/context", () => ({ useWorkspace: () => ({ slug: "acme" }) }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => <a href="/acme/settings/sources">{children}</a>,
}));

const agents: Source = {
	id: "source-1",
	name: "Pilot runner",
	product: "agents",
	teamId: "team-1",
	assigneeId: null,
	lowestSeverity: "high",
	closeWhenCleared: false,
	linkOrigins: [],
	paused: false,
	lastHeardAt: null,
};
const issue = { id: "issue-1", teamId: "team-1" } as ActiveIssue;

/** Answers the gateway's calls in order, and records what each asked. */
function gateway(...answers: [number, unknown][]) {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			const [status, body] = answers.shift() ?? [500, {}];
			return Response.json(body, { status });
		}),
	);
	return calls;
}

function row() {
	return render(
		<RunnerApproval issue={issue} issueKey="ENG-1">
			{(summary) => <button type="button">{summary}</button>}
		</RunnerApproval>,
	);
}

beforeEach(() => {
	sources.splice(0, sources.length, agents);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("WEB-87: approves an unapproved assignment for the runner, and then names where it goes", async () => {
	const calls = gateway(
		[404, { error: "Not found" }],
		[
			201,
			{
				requestId: "request-1",
				repository: "acme/site",
				executor: "cloud",
				activeAttemptId: null,
				lastAttemptId: null,
				lastAttemptState: null,
			},
		],
	);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	fireEvent.change(page.getByLabelText("Repository"), { target: { value: " Acme/Site " } });
	fireEvent.change(page.getByLabelText("Runs on"), { target: { value: "cloud" } });
	fireEvent.click(page.getByRole("button", { name: "Approve" }));
	expect(await page.findByRole("button", { name: "Cloud · acme/site" })).toBeTruthy();
	expect(calls).toEqual([
		{ url: "/api/work-runs/approval", body: { workspace: "acme", issue: "ENG-1" } },
		{
			url: "/api/work-runs/register",
			body: {
				workspace: "acme",
				issue: "ENG-1",
				repository: "acme/site",
				sourceId: "source-1",
				executor: "cloud",
			},
		},
	]);
});

it("WEB-87: shows an existing approval, its source and how its last attempt ended", async () => {
	gateway([
		200,
		{
			requestId: "request-1",
			repository: "acme/site",
			executor: "local-runner",
			sourceId: "source-1",
			activeAttemptId: null,
			lastAttemptId: "attempt-1",
			lastAttemptState: "failed",
		},
	]);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Local runner · acme/site" }));
	expect(page.getByText("Approved for this assignment")).toBeTruthy();
	expect(page.getByText("Pilot runner")).toBeTruthy();
	expect(page.getByText("The last attempt failed.")).toBeTruthy();
	expect(page.queryByRole("button", { name: "Approve" })).toBeNull();
});

it("WEB-87: keeps a refused approval's reason on screen, and checks the repository first", async () => {
	const calls = gateway(
		[404, { error: "Not found" }],
		[
			409,
			{ error: "Choose a live issue assigned to a runner and a reporting source for its team" },
		],
	);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	fireEvent.change(page.getByLabelText("Repository"), { target: { value: "not a repo" } });
	fireEvent.click(page.getByRole("button", { name: "Approve" }));
	expect((await page.findByRole("alert")).textContent).toBe(
		"Name a GitHub repository as owner/repo.",
	);
	expect(calls).toHaveLength(1);
	fireEvent.change(page.getByLabelText("Repository"), { target: { value: "acme/site" } });
	fireEvent.click(page.getByRole("button", { name: "Approve" }));
	await waitFor(() =>
		expect(page.getByRole("alert").textContent).toBe(
			"Choose a live issue assigned to a runner and a reporting source for its team",
		),
	);
	expect(page.getByRole("button", { name: "Not approved" })).toBeTruthy();
});

it("WEB-87: without an Agents source for the team, it says where to add one", async () => {
	sources.splice(0, sources.length);
	gateway([404, { error: "Not found" }]);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	expect(page.getByRole("link", { name: "Sources" })).toBeTruthy();
	expect(page.queryByLabelText("Repository")).toBeNull();
});

it("WEB-87: a failed read says so and can ask again", async () => {
	gateway([503, { error: "This workspace is moving" }], [404, { error: "Not found" }]);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Could not check" }));
	expect(page.getByRole("alert").textContent).toBe("This workspace is moving");
	fireEvent.click(page.getByRole("button", { name: "Try again" }));
	expect(await page.findByRole("button", { name: "Not approved" })).toBeTruthy();
});

it("WEB-87: says how the last attempt went in plain words", () => {
	expect(
		["queued", "running", "passed", "failed", "cancelled"].map((state) =>
			pastTense(state as never),
		),
	).toEqual(["is queued", "is running", "passed", "failed", "was cancelled"]);
});
