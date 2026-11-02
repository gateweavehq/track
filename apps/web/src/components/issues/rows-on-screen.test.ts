import { describe, expect, it } from "vitest";
import { rangeAt } from "./rows-on-screen";

/** Ten items of 40 px each, then the end of the list. */
const tenRows = Array.from({ length: 11 }, (_, index) => index * 40);

describe("rangeAt", () => {
	it("covers the items that overlap the band", () => {
		expect(rangeAt(tenRows, 0, 100)).toEqual([0, 3]);
		expect(rangeAt(tenRows, 130, 200)).toEqual([3, 5]);
	});

	it("keeps an item that the band starts inside of", () => {
		expect(rangeAt(tenRows, 119, 121)).toEqual([2, 4]);
	});

	it("clamps to the list at both ends", () => {
		expect(rangeAt(tenRows, -600, 40)).toEqual([0, 1]);
		expect(rangeAt(tenRows, 1000, 1200)).toEqual([9, 10]);
	});

	it("gives one item for an empty band, so the row can take focus", () => {
		expect(rangeAt(tenRows, 80, 80)).toEqual([2, 3]);
	});

	it("is empty for an empty list", () => {
		expect(rangeAt([0], 0, 100)).toEqual([0, 0]);
	});
});
