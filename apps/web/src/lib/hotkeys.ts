import { useEffect, useRef } from "react";

interface KeyLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/**
 * Normalizes a key event to a combo string such as `c`, `?`, `mod+k` or `shift+Enter`.
 * `mod` is Cmd on macOS and Ctrl elsewhere. Printable keys use the character they produce, so
 * Shift is implied (`?`, not `shift+/`), and letters ignore Caps Lock. Named keys keep their
 * `KeyboardEvent.key` name and spell out Shift.
 */
export function comboOf(event: KeyLike): string {
	const printable = event.key.length === 1;
	const key = printable && !event.shiftKey ? event.key.toLowerCase() : event.key;
	let combo = key;
	if (!printable && event.shiftKey) combo = `shift+${combo}`;
	if (event.altKey) combo = `alt+${combo}`;
	if (event.metaKey || event.ctrlKey) combo = `mod+${combo}`;
	return combo;
}

/** How to write the `mod` key for this device. */
export const MOD_LABEL =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** True when the user is typing, so single-key shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** An open dialog, popover or menu owns the keyboard until it closes. */
function overlayIsOpen(): boolean {
	return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

export type Hotkeys = Partial<Record<string, (event: KeyboardEvent) => void>>;

/**
 * Binds keyboard shortcuts while the component is mounted. `mod+` combos work everywhere,
 * including in text fields. Other shortcuts are ignored while the user types or while an
 * overlay is open. The latest handlers are always used, so callers can pass inline functions.
 */
export function useHotkeys(hotkeys: Hotkeys, enabled = true): void {
	const ref = useRef(hotkeys);
	ref.current = hotkeys;

	useEffect(() => {
		if (!enabled) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.isComposing) return;
			const combo = comboOf(event);
			const handler = ref.current[combo];
			if (!handler) return;
			if (!combo.startsWith("mod+") && (isEditableTarget(event.target) || overlayIsOpen())) return;
			event.preventDefault();
			handler(event);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled]);
}
