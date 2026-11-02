import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * How far past the visible part a list still renders, so scrolling does not reveal blank space
 * before the next pass. Measured in pixels, so rows and group headers of different heights share it.
 */
export const OVERSCAN = 600;

/**
 * The items `[first, last)` of a scrolling list that are near its visible part, for a list
 * whose items start at `offsets` (one entry per item, plus the end of the list last). Renders
 * nothing for the rest; the caller keeps their height with spacers. Follows the scrolling
 * ancestor, or the page, as it scrolls and resizes.
 */
export function useItemsOnScreen(
	offsets: readonly number[],
	anchor: RefObject<HTMLElement | null>,
): readonly [number, number] {
	const count = offsets.length - 1;
	const [range, setRange] = useState<readonly [number, number]>(() => [0, Math.min(count, 50)]);
	useLayoutEffect(() => {
		const element = anchor.current;
		if (!element) {
			setRange([0, Math.min(count, 50)]);
			return;
		}
		const scroller = scrollParent(element);
		const update = () => {
			const top = element.getBoundingClientRect().top;
			const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
			const next = rangeAt(offsets, view.top - top - OVERSCAN, view.bottom - top + OVERSCAN);
			setRange((current) => (current[0] === next[0] && current[1] === next[1] ? current : next));
		};
		update();
		const target = scroller ?? window;
		target.addEventListener("scroll", update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(scroller ?? document.documentElement);
		return () => {
			target.removeEventListener("scroll", update);
			resize.disconnect();
		};
	}, [offsets, anchor, count]);
	return range;
}

/**
 * The items `[first, last)` that overlap the band from `top` to `bottom`, both measured from the
 * start of the list. Always at least one item when there is one, so a row can be focused.
 */
export function rangeAt(
	offsets: readonly number[],
	top: number,
	bottom: number,
): readonly [number, number] {
	const count = offsets.length - 1;
	if (count <= 0) return [0, 0];
	// Each item's start is `offsets[i]`; the last entry is the end of the list, not an item.
	const starts = offsets.slice(0, count);
	const first = Math.max(0, countWhile(starts, (start) => start <= top) - 1);
	const last = Math.min(
		count,
		Math.max(
			first + 1,
			countWhile(starts, (start) => start < bottom),
		),
	);
	return [first, last];
}

/** How many leading entries satisfy `holds`, which must be true up to some point and then false. */
function countWhile(values: readonly number[], holds: (value: number) => boolean): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (holds(values[middle] ?? 0)) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The nearest ancestor that scrolls vertically, or none when the document itself scrolls. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowY } = getComputedStyle(parent);
		if (overflowY === "auto" || overflowY === "scroll") return parent;
	}
	return null;
}
