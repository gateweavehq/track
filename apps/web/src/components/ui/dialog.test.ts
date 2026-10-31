import { describe, expect, it } from "vitest";
import { cn } from "#/lib/utils";
import { DIALOG_CONTENT_CLASS } from "./dialog";

describe("A dialog's box", () => {
	// Centred and taller than a short window, a dialog's title and its buttons were out of reach,
	// and nothing scrolled.
	it("is never taller than the window, and scrolls within itself", () => {
		const classes = DIALOG_CONTENT_CLASS.split(" ");
		expect(classes).toContain("max-h-[calc(100dvh-2rem)]");
		expect(classes).toContain("overflow-y-auto");
	});

	it("keeps both when a dialog sets its own width", () => {
		const classes = cn(DIALOG_CONTENT_CLASS, "max-w-md").split(" ");
		expect(classes).toEqual(
			expect.arrayContaining(["max-h-[calc(100dvh-2rem)]", "overflow-y-auto", "max-w-md"]),
		);
		expect(classes).not.toContain("max-w-lg");
	});

	// The command palette lays out its own scrolling list.
	it("lets a dialog that scrolls its own content turn overflow off", () => {
		const classes = cn(DIALOG_CONTENT_CLASS, "overflow-hidden p-0").split(" ");
		expect(classes).toContain("overflow-hidden");
		expect(classes).not.toContain("overflow-y-auto");
	});
});
