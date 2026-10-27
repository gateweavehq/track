import { describe, expect, it } from "vitest";
import { comboOf } from "./hotkeys";

const press = (
	key: string,
	modifiers: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) =>
	comboOf({
		key,
		metaKey: modifiers.meta ?? false,
		ctrlKey: modifiers.ctrl ?? false,
		altKey: modifiers.alt ?? false,
		shiftKey: modifiers.shift ?? false,
	});

describe("comboOf", () => {
	it("names single keys by the character they type", () => {
		expect(press("c")).toBe("c");
		expect(press("/")).toBe("/");
		expect(press("?", { shift: true })).toBe("?");
	});

	it("ignores Caps Lock but not Shift", () => {
		expect(press("C")).toBe("c");
		expect(press("C", { shift: true })).toBe("C");
	});

	it("treats Cmd and Ctrl alike", () => {
		expect(press("k", { meta: true })).toBe("mod+k");
		expect(press("k", { ctrl: true })).toBe("mod+k");
	});

	it("spells out Shift and Alt for named keys", () => {
		expect(press("Enter", { ctrl: true })).toBe("mod+Enter");
		expect(press("ArrowDown")).toBe("ArrowDown");
		expect(press("Tab", { shift: true })).toBe("shift+Tab");
		expect(press("ArrowUp", { alt: true, shift: true })).toBe("alt+shift+ArrowUp");
	});
});
