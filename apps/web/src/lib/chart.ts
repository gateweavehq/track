import { type RefObject, useLayoutEffect, useState } from "react";

// What the hand-drawn SVG charts (a cycle's burn-up, a team's insights) share.

/** The axis's top: a round number at or above `max`, with a whole number halfway. */
export function axisTop(max: number): number {
	const half = Math.max(1, max) / 2;
	const magnitude = 10 ** Math.floor(Math.log10(half));
	const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= half);
	return Math.max(2, Math.ceil(step ?? half) * 2);
}

/** The width of an element, kept up to date as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => setWidth(element.clientWidth);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
