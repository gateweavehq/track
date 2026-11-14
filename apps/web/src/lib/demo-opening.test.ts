import { describe, expect, it } from "vitest";
import { SANDBOX_LIFETIME_MS } from "./demo-lifetime";
import { LIST_WAIT_CAP_MS, STEP_TIMERS_MS, stepStates } from "./demo-opening";
import { deletionLabel } from "./demo-time";

describe("the opening screen's steps", () => {
	it("starts with the first step active", () => {
		expect(stepStates({ elapsedMs: 0, sinceServerMs: null, listShown: false })).toEqual([
			"active",
			"idle",
			"idle",
			"idle",
		]);
	});

	it("moves the first two steps on timers", () => {
		const [first, second] = STEP_TIMERS_MS;
		expect(stepStates({ elapsedMs: first, sinceServerMs: null, listShown: false })).toEqual([
			"done",
			"active",
			"idle",
			"idle",
		]);
		expect(stepStates({ elapsedMs: second, sinceServerMs: null, listShown: false })).toEqual([
			"done",
			"done",
			"active",
			"idle",
		]);
	});

	it("never completes the third step before the server has answered", () => {
		for (const elapsedMs of [3500, 20_000, 600_000]) {
			const states = stepStates({ elapsedMs, sinceServerMs: null, listShown: true });
			expect(states[2]).toBe("active");
			expect(states[3]).toBe("idle");
		}
	});

	it("finishes every step the server's answer stands for, even ahead of their timers", () => {
		expect(stepStates({ elapsedMs: 300, sinceServerMs: 0, listShown: false })).toEqual([
			"done",
			"done",
			"done",
			"active",
		]);
	});

	it("completes the last step only once the issue list has shown", () => {
		expect(stepStates({ elapsedMs: 4000, sinceServerMs: 500, listShown: false })[3]).toBe("active");
		expect(stepStates({ elapsedMs: 4000, sinceServerMs: 500, listShown: true })).toEqual([
			"done",
			"done",
			"done",
			"done",
		]);
	});

	it("gives up waiting for the list after the cap", () => {
		const before = stepStates({
			elapsedMs: 9000,
			sinceServerMs: LIST_WAIT_CAP_MS - 1,
			listShown: false,
		});
		expect(before[3]).toBe("active");
		const after = stepStates({
			elapsedMs: 9000,
			sinceServerMs: LIST_WAIT_CAP_MS,
			listShown: false,
		});
		expect(after[3]).toBe("done");
	});

	it("has at most one active step, and nothing but idle steps after it", () => {
		for (const elapsedMs of [0, 800, 2000, 4000]) {
			for (const sinceServerMs of [null, 0, 1000, 6000]) {
				for (const listShown of [false, true]) {
					const states = stepStates({ elapsedMs, sinceServerMs, listShown });
					expect(states.filter((state) => state === "active").length).toBeLessThanOrEqual(1);
					const firstNotDone = states.findIndex((state) => state !== "done");
					if (firstNotDone !== -1) {
						expect(states.slice(firstNotDone + 1).every((state) => state === "idle")).toBe(true);
					}
				}
			}
		}
	});
});

describe("the demo bar's countdown", () => {
	const created = Date.UTC(2026, 10, 14, 12, 0, 0);
	const at = (ms: number) => created + ms;
	const minute = 60_000;
	const hour = 60 * minute;

	it("uses the day cleanup allows a sandbox", () => {
		expect(SANDBOX_LIFETIME_MS).toBe(24 * hour);
	});

	it("counts whole hours while there is an hour or more", () => {
		expect(deletionLabel(created, at(0))).toBe("Deleted in 24 h");
		expect(deletionLabel(created, at(30 * minute))).toBe("Deleted in 23 h");
		expect(deletionLabel(created, at(23 * hour))).toBe("Deleted in 1 h");
	});

	it("counts minutes in the last hour, rounding up", () => {
		expect(deletionLabel(created, at(23 * hour + 1))).toBe("Deleted in 60 min");
		expect(deletionLabel(created, at(23 * hour + 30 * minute))).toBe("Deleted in 30 min");
		expect(deletionLabel(created, at(24 * hour - 1000))).toBe("Deleted in 1 min");
	});

	it("says soon once the day is up, since cleanup runs every ten minutes", () => {
		expect(deletionLabel(created, at(24 * hour))).toBe("Deleted soon");
		expect(deletionLabel(created, at(30 * hour))).toBe("Deleted soon");
	});
});
