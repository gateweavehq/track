import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";

/**
 * Text that is edited in place. While focused it shows the user's own text; on blur (or after
 * `idleMs` without typing, and on the way out of the page) it is saved if it changed. Escape
 * throws the edit away, and Enter saves a single-line field.
 */
export function TextField({
	value,
	onSave,
	label,
	placeholder,
	maxLength,
	className,
	singleLine = false,
	idleMs,
}: {
	value: string;
	onSave: (next: string) => unknown;
	label: string;
	placeholder?: string;
	maxLength: number;
	className?: string;
	singleLine?: boolean;
	idleMs?: number;
}) {
	const [draft, setDraftState] = useState<string | null>(null);
	// Event handlers read the draft from a ref: blur can follow a cancel before React re-renders.
	const draftRef = useRef<string | null>(null);
	const latest = useRef({ value, onSave });
	latest.current = { value, onSave };

	const setDraft = (next: string | null) => {
		draftRef.current = next;
		setDraftState(next);
	};
	const flush = useCallback(() => {
		const current = draftRef.current;
		if (current !== null && current !== latest.current.value) latest.current.onSave(current);
	}, []);

	useEffect(() => {
		if (draft === null || idleMs === undefined) return;
		const timer = setTimeout(flush, idleMs);
		return () => clearTimeout(timer);
	}, [draft, idleMs, flush]);
	// Leaving the page does not blur the field, so save what was typed on the way out.
	useEffect(() => flush, [flush]);

	return (
		<textarea
			value={draft ?? value}
			onFocus={() => {
				if (draftRef.current === null) setDraft(latest.current.value);
			}}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => {
				flush();
				setDraft(null);
			}}
			onKeyDown={(event) => {
				if (singleLine && event.key === "Enter") {
					event.preventDefault();
					event.currentTarget.blur();
				} else if (event.key === "Escape") {
					setDraft(null);
					event.currentTarget.blur();
				}
			}}
			aria-label={label}
			placeholder={placeholder}
			rows={singleLine ? 1 : undefined}
			maxLength={maxLength}
			className={cn(
				"field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground",
				className,
			)}
		/>
	);
}
