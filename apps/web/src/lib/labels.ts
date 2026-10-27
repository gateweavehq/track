import type { Label } from "@gateweave/track-protocol";

/** The colors offered for labels. Mid-tone, so they read on light and dark backgrounds. */
export const LABEL_COLORS = [
	{ value: "#e5484d", name: "Red" },
	{ value: "#f76b15", name: "Orange" },
	{ value: "#ffc53d", name: "Yellow" },
	{ value: "#46a758", name: "Green" },
	{ value: "#12a594", name: "Teal" },
	{ value: "#0090ff", name: "Blue" },
	{ value: "#6e56cf", name: "Purple" },
	{ value: "#d6409f", name: "Pink" },
	{ value: "#8d8d8d", name: "Gray" },
] as const;

/** A color for a new label, the same for the same name, so labels made by agents vary too. */
export function defaultLabelColor(name: string): string {
	let hash = 0;
	for (const char of name.trim().toLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
	return (LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length] ?? LABEL_COLORS[0]).value;
}

/** Label names are unique ignoring case, as the server enforces. */
export function findLabelByName<L extends Pick<Label, "name">>(
	labels: Iterable<L>,
	name: string,
): L | undefined {
	const folded = name.trim().toLowerCase();
	for (const label of labels) if (label.name.toLowerCase() === folded) return label;
	return undefined;
}

export function compareLabels(a: Pick<Label, "name">, b: Pick<Label, "name">): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
