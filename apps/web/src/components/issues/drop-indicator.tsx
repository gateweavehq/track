import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/types";

/** The line that shows where a dragged issue will land, on the top or bottom edge of another. */
export function DropIndicator({ edge, gap = 0 }: { edge: Edge; gap?: number }) {
	// Centered in the gap between items, so the line sits between them rather than on one.
	const offset = -(gap / 2) - 1;
	return (
		<div
			aria-hidden
			style={edge === "top" ? { top: offset } : { bottom: offset }}
			className="pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full bg-primary"
		/>
	);
}
