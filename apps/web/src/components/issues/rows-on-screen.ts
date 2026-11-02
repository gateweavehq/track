import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

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

/**
 * The real heights of a list's kinds of entry, each found in `container` by its selector. They are
 * set in rem, so they follow the browser's font size: `defaults` stand in until one of each has
 * rendered. Measured from the first rendered one of each, and again whenever it resizes.
 */
export function useMeasuredHeights<K extends string>(
	container: RefObject<HTMLElement | null>,
	selectors: Readonly<Record<K, string>>,
	defaults: Readonly<Record<K, number>>,
): Readonly<Record<K, number>> {
	const [heights, setHeights] = useState(defaults);
	const watched = useRef<(Element | null)[]>([]);
	const observer = useRef<ResizeObserver | null>(null);
	useEffect(() => () => observer.current?.disconnect(), []);
	// After every render, since the entries measured may have scrolled away and been unmounted.
	useLayoutEffect(() => {
		const element = container.current;
		if (!element) return;
		const keys = Object.keys(selectors) as K[];
		const found = keys.map((key) => element.querySelector(selectors[key]));
		if (
			found.length === watched.current.length &&
			found.every((entry, index) => entry === watched.current[index])
		) {
			return;
		}
		watched.current = found;
		const measure = () => {
			setHeights((current) => {
				let next = current;
				keys.forEach((key, index) => {
					const height = found[index]?.getBoundingClientRect().height || current[key];
					if (height !== current[key]) next = { ...next, [key]: height };
				});
				return next;
			});
		};
		measure();
		observer.current?.disconnect();
		observer.current = new ResizeObserver(measure);
		for (const entry of found) if (entry) observer.current.observe(entry);
	});
	return heights;
}

/**
 * How far down from the top of `view` the scroller's own sticky children, such as the page's
 * header and its filters, cover what scrolls beneath them.
 */
export function stickyCover(scroller: HTMLElement | null, viewTop: number): number {
	let covered = 0;
	for (const child of scroller?.children ?? []) {
		if (getComputedStyle(child).position !== "sticky") continue;
		covered = Math.max(covered, child.getBoundingClientRect().bottom - viewTop);
	}
	return covered;
}

/**
 * Scrolls the scrolling ancestor of `list`, or the page, so the entry from `top` to `bottom`
 * pixels into the list is in view: clear of what `covered` says sticks over the top of the
 * scroller, and of the bulk-edit bar. Says whether it scrolled.
 */
export function revealEntry(
	list: HTMLElement,
	top: number,
	bottom: number,
	covered: (scroller: HTMLElement | null, viewTop: number) => number,
): boolean {
	const scroller = scrollParent(list);
	const view = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
	const clearTop = view.top + covered(scroller, view.top);
	// The bulk-edit bar floats over the bottom while issues are picked.
	const bar = document.querySelector("[data-bulk-bar]")?.getBoundingClientRect().top;
	const clearBottom = Math.min(view.bottom, bar ?? view.bottom);
	const listTop = list.getBoundingClientRect().top;
	const start = listTop + top;
	const end = listTop + bottom;
	const delta = start < clearTop ? start - clearTop : end > clearBottom ? end - clearBottom : 0;
	if (delta === 0) return false;
	(scroller ?? window).scrollBy({ top: delta });
	return true;
}
