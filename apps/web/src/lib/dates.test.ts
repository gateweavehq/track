import { describe, expect, it } from "vitest";
import {
	addDays,
	formatDay,
	formatFullDay,
	formatShortDay,
	formatWeekday,
	parseDay,
	toDay,
	today,
} from "./dates";

describe("calendar days", () => {
	it("formats a day without moving it across time zones", () => {
		expect(formatDay("2026-12-31")).toMatch(/31/);
		expect(formatDay("2026-12-31")).toMatch(/2026/);
		const now = new Date(2026, 10, 30);
		expect(formatShortDay("2026-12-31", now)).toMatch(/31/);
		expect(formatShortDay("2026-12-31", now)).not.toMatch(/2026/);
		expect(formatShortDay("2027-01-05", now)).toMatch(/2027/);
	});

	it("names a day in full and by weekday", () => {
		expect(formatFullDay("2026-12-31")).toMatch(/31/);
		expect(formatFullDay("2026-12-31")).toMatch(/2026/);
		expect(formatWeekday("2026-11-02")).toBe(
			new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2026, 10, 2)),
		);
		expect(formatFullDay("nonsense")).toBe("nonsense");
	});

	it("round-trips a day through a date", () => {
		for (const date of ["2026-01-01", "2026-03-29", "2026-10-25", "2028-02-29"]) {
			const parsed = parseDay(date);
			expect(parsed && toDay(parsed)).toBe(date);
		}
		expect(parseDay("nonsense")).toBeNull();
	});

	it("reads today in the viewer's time zone", () => {
		expect(today(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
		expect(today(new Date(2026, 10, 30, 0, 0))).toBe("2026-11-30");
	});

	it("counts days across months and years", () => {
		expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
		expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});
});
