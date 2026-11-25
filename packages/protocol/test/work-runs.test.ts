import { expect, it } from "vitest";
import { claimWorkRunInput, registerWorkRunInput, reportWorkRunInput } from "../src";

const attemptId = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";

it("WEB-84: a claim's ids have one spelling, whichever the runner sent", () => {
	const claim = {
		requestId: attemptId.toUpperCase(),
		claimId: "0D3B3A4E-6C1F-4A8B-9E2D-7F5C1B2A3D4E",
		previousAttemptId: attemptId.toUpperCase(),
	};
	expect(claimWorkRunInput.parse(claim)).toEqual({
		requestId: attemptId,
		claimId: "0d3b3a4e-6c1f-4a8b-9e2d-7f5c1b2a3d4e",
		previousAttemptId: attemptId,
		executor: "local-runner",
	});
});

it("WEB-84: a report's link fits the limit after normalization, as the object parses it again", () => {
	const report = { attemptId, sequence: 1, state: "running" };
	const short = reportWorkRunInput.parse({ ...report, url: "https://logs.example/run" });
	expect(reportWorkRunInput.parse(short)).toEqual(short);
	// 221 characters as sent, about 1,800 once each character is percent-encoded.
	const long = `https://logs.example/${"界".repeat(200)}`;
	expect(long.length).toBeLessThanOrEqual(1024);
	expect(reportWorkRunInput.safeParse({ ...report, url: long }).success).toBe(false);
});

it("WEB-84: a registration and a claim name their executor, the local runner unless they say", () => {
	const registration = { issue: "ENG-1", repository: "acme/site", sourceId: "source" };
	expect(registerWorkRunInput.parse(registration).executor).toBe("local-runner");
	expect(registerWorkRunInput.parse({ ...registration, executor: "cloud" }).executor).toBe("cloud");
	// Hosted runs report through their source, never through a scoped claim.
	expect(
		registerWorkRunInput.safeParse({ ...registration, executor: "agents-hosted" }).success,
	).toBe(false);
	const claim = { requestId: attemptId, claimId: attemptId };
	expect(claimWorkRunInput.parse(claim).executor).toBe("local-runner");
	expect(claimWorkRunInput.safeParse({ ...claim, executor: "docker" }).success).toBe(false);
});
