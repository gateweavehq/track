import { afterEach, expect, it, vi } from "vitest";
import { approveWorkRun, normalizeRepository, readApproval } from "./work-runs";

afterEach(() => {
	vi.unstubAllGlobals();
});

const approval = {
	requestId: "request-1",
	repository: "acme/site",
	executor: "cloud",
	sourceId: "source-1",
	activeAttemptId: null,
	lastAttemptId: "attempt-1",
	lastAttemptState: "passed",
};

function answer(status: number, body: unknown) {
	const fetch = vi.fn(async () => Response.json(body, { status }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

it("WEB-87: reads the issue's approval from the work-run gateway", async () => {
	const fetch = answer(200, approval);
	expect(await readApproval("acme", "ENG-1")).toEqual({ ok: true, approval });
	expect(fetch).toHaveBeenCalledWith("/api/work-runs/approval", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspace: "acme", issue: "ENG-1" }),
	});
});

it("WEB-87: an assignment with no approval reads as none, and a refusal keeps its reason", async () => {
	answer(404, { error: "Not found" });
	expect(await readApproval("acme", "ENG-1")).toEqual({ ok: true, approval: null });
	answer(403, { error: "Only workspace admins can manage work" });
	expect(await readApproval("acme", "ENG-1")).toEqual({
		ok: false,
		message: "Only workspace admins can manage work",
	});
	answer(200, { ...approval, executor: "laptop" });
	expect(await readApproval("acme", "ENG-1")).toMatchObject({ ok: false });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("offline");
		}),
	);
	expect(await readApproval("acme", "ENG-1")).toEqual({
		ok: false,
		message: "Track could not answer. Try again.",
	});
});

it("WEB-87: approving registers the assignment and keeps the source it named", async () => {
	const { sourceId: _, ...registered } = approval;
	const fetch = answer(201, registered);
	const form = { repository: "acme/site", sourceId: "source-1", executor: "cloud" as const };
	expect(await approveWorkRun("acme", "ENG-1", form)).toEqual({ ok: true, approval });
	expect(fetch).toHaveBeenCalledWith(
		"/api/work-runs/register",
		expect.objectContaining({
			body: JSON.stringify({ workspace: "acme", issue: "ENG-1", ...form }),
		}),
	);
	answer(409, { error: "This assignment already has a destination, repository and executor" });
	expect(await approveWorkRun("acme", "ENG-1", form)).toEqual({
		ok: false,
		message: "This assignment already has a destination, repository and executor",
	});
});

it("WEB-87: a repository is a GitHub owner/repo, kept as the server keeps it", () => {
	expect(normalizeRepository("  Acme/Site ")).toBe("acme/site");
	for (const value of ["", "acme", "acme/site/extra", "acme/..", "https://github.com/acme/site"]) {
		expect(normalizeRepository(value)).toBeNull();
	}
});
