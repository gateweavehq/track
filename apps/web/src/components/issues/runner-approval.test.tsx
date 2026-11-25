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
	const read = { url: "/api/work-runs/approval", body: { workspace: "acme", issue: "ENG-1" } };
	expect(calls).toEqual([
		read,
		read,
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

const failed = {
	requestId: "request-1",
	repository: "acme/site",
	executor: "local-runner",
	sourceId: "source-1",
	activeAttemptId: null,
	lastAttemptId: "attempt-1",
	lastAttemptState: "failed",
};

it("WEB-87: shows an existing approval, its source and how its last attempt ended", async () => {
	gateway([200, failed], [200, failed]);
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
	expect(calls).toHaveLength(2);
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
	gateway([404, { error: "Not found" }], [404, { error: "Not found" }]);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	expect(page.getByRole("link", { name: "Sources" })).toBeTruthy();
	expect(page.queryByLabelText("Repository")).toBeNull();
});

it("WEB-87: a failed read says so and can ask again", async () => {
	const calls = gateway(
		[503, { error: "This workspace is moving" }],
		[503, { error: "This workspace is moving" }],
		[404, { error: "Not found" }],
	);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Could not check" }));
	await waitFor(() => expect(calls).toHaveLength(2));
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

it("WEB-87: reads again on opening, so an approval made elsewhere or a new attempt shows", async () => {
	gateway(
		[404, { error: "Not found" }],
		[
			200,
			{
				...failed,
				activeAttemptId: "attempt-2",
				lastAttemptId: "attempt-2",
				lastAttemptState: "running",
			},
		],
	);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	expect(await page.findByText("An attempt is under way.")).toBeTruthy();
	expect(page.getByRole("button", { name: "Local runner · acme/site" })).toBeTruthy();
});

it("WEB-87: a failed refresh keeps the approval on screen", async () => {
	const calls = gateway([200, failed], [503, { error: "This workspace is moving" }]);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Local runner · acme/site" }));
	await waitFor(() => expect(calls).toHaveLength(2));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(page.getByText("The last attempt failed.")).toBeTruthy();
	expect(page.queryByRole("alert")).toBeNull();
});

it("WEB-87: a read that answers after the approval does not undo it", async () => {
	let answerRead: (response: Response) => void = () => {};
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			calls.push(url);
			if (calls.length === 1) return Promise.resolve(Response.json({}, { status: 404 }));
			if (calls.length === 2)
				return new Promise<Response>((resolve) => {
					answerRead = resolve;
				});
			return Promise.resolve(
				Response.json(
					{ ...failed, executor: "cloud", lastAttemptId: null, lastAttemptState: null },
					{ status: 201 },
				),
			);
		}),
	);
	const page = row();
	fireEvent.click(await page.findByRole("button", { name: "Not approved" }));
	fireEvent.change(page.getByLabelText("Repository"), { target: { value: "acme/site" } });
	fireEvent.click(page.getByRole("button", { name: "Approve" }));
	expect(await page.findByRole("button", { name: "Cloud · acme/site" })).toBeTruthy();
	expect(calls).toEqual([
		"/api/work-runs/approval",
		"/api/work-runs/approval",
		"/api/work-runs/register",
	]);
	// The read the opening started, from before the approval, now says there is none.
	answerRead(Response.json({}, { status: 404 }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(page.getByRole("button", { name: "Cloud · acme/site" })).toBeTruthy();
});
