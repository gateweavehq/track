import { describe, expect, it, vi } from "vitest";
import { EndedSessions } from "./ended-sessions";

function setup() {
	const reports: [string, string[]][] = [];
	const background: Promise<unknown>[] = [];
	const ended = new EndedSessions(
		async (userId, sessionIds) => {
			reports.push([userId, sessionIds]);
		},
		(work) => background.push(work),
	);
	return { ended, reports, background };
}

describe("ended sessions", () => {
	it("reports a request's sessions once per user, when the request is over", async () => {
		const { ended, reports, background } = setup();
		const request = {};
		ended.add(request, "ana", "s1");
		ended.add(request, "ana", "s2");
		ended.add(request, "ben", "s3");
		expect(reports).toEqual([]);

		ended.flush(request);
		await Promise.all(background);

		expect(background).toHaveLength(1);
		expect(reports).toEqual([
			["ana", ["s1", "s2"]],
			["ben", ["s3"]],
		]);
	});

	it("keeps requests apart", async () => {
		const { ended, reports, background } = setup();
		const first = {};
		const second = {};
		ended.add(first, "ana", "s1");
		ended.add(second, "ana", "s2");

		ended.flush(first);
		ended.flush(first);
		await background[0];

		expect(reports).toEqual([["ana", ["s1"]]]);
	});

	it("reports a batch no request flushes by itself", async () => {
		vi.useFakeTimers();
		try {
			const { ended, reports, background } = setup();
			ended.add(null, "ana", "s1");
			await vi.runAllTimersAsync();
			await Promise.all(background);
			expect(reports).toEqual([["ana", ["s1"]]]);
		} finally {
			vi.useRealTimers();
		}
	});
});
