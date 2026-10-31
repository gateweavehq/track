import type { Member } from "@gateweave/track-protocol";
import { type KeyboardEvent, type RefObject, useId, useState } from "react";
import { MemberAvatar } from "#/components/members/member-avatar";
import { caretOffset } from "#/lib/caret";
import { insertMention, type MentionQuery, mentionCandidates, mentionQuery } from "#/lib/mentions";
import { useActiveMembers } from "#/lib/queries";
import { cn } from "#/lib/utils";

const MENU_WIDTH = 256;

interface Typing extends MentionQuery {
	/** Where the menu goes, below the "@", from the text box's top-left corner. */
	top: number;
	left: number;
	active: number;
}

/**
 * Offers the workspace's members when someone types "@" in a text box, and puts a mention of the
 * one they pick in its place. The text box calls `update` when its text or caret changes, `close`
 * when it loses focus and `onKeyDown` before its own key handling, and takes `aria`. `menu` goes
 * right after it, inside a wrapper that is positioned and holds nothing else above the box.
 */
export function useMentions(
	textarea: RefObject<HTMLTextAreaElement | null>,
	setValue: (next: string) => void,
) {
	const members = useActiveMembers();
	const [typing, setTyping] = useState<Typing | null>(null);
	const id = useId();
	const candidates = typing ? mentionCandidates(members, typing.query) : [];
	const open = typing !== null && candidates.length > 0;
	const active = typing ? Math.min(typing.active, candidates.length - 1) : 0;

	function update(element: HTMLTextAreaElement) {
		const caret = element.selectionStart;
		const query = element.selectionEnd === caret ? mentionQuery(element.value, caret) : null;
		if (!query) {
			setTyping(null);
			return;
		}
		const at = caretOffset(element, query.start);
		const left = Math.max(0, Math.min(at.left, element.clientWidth - MENU_WIDTH));
		setTyping((current) => ({
			...query,
			top: at.top + at.height,
			left,
			// The highlighted member stays while the same mention is typed.
			active: current?.start === query.start ? current.active : 0,
		}));
	}

	function pick(member: Member) {
		const element = textarea.current;
		if (!element || !typing) return;
		const next = insertMention(element.value, typing.start, element.selectionStart, member);
		setValue(next.value);
		setTyping(null);
		requestAnimationFrame(() => {
			element.focus();
			element.setSelectionRange(next.caret, next.caret);
		});
	}

	/** Handles the menu's keys while it is open. Returns whether the key was the menu's. */
	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
		if (!open || !typing || event.nativeEvent.isComposing) return false;
		const move = (by: number) =>
			setTyping({ ...typing, active: (active + by + candidates.length) % candidates.length });
		const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
		if (event.key === "ArrowDown") move(1);
		else if (event.key === "ArrowUp") move(-1);
		else if ((event.key === "Enter" || event.key === "Tab") && !modified) {
			const member = candidates[active];
			if (member) pick(member);
		} else if (event.key === "Escape") setTyping(null);
		else return false;
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	const option = (index: number) => `${id}-option-${index}`;
	const menu = open ? (
		<div
			id={`${id}-menu`}
			role="listbox"
			aria-label="People to mention"
			style={{ top: typing.top, left: typing.left, width: MENU_WIDTH }}
			className="absolute z-50 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
		>
			{candidates.map((member, index) => (
				// biome-ignore lint/a11y/useKeyWithClickEvents: the text box keeps the focus and handles the keys, pointing at the option with aria-activedescendant
				<div
					key={member.id}
					id={option(index)}
					role="option"
					aria-selected={index === active}
					tabIndex={-1}
					// The text box keeps the focus, and the caret where it was.
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => pick(member)}
					onMouseMove={() => index !== active && setTyping({ ...typing, active: index })}
					className={cn(
						"flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
						index === active && "bg-accent text-accent-foreground",
					)}
				>
					<span aria-hidden className="contents">
						<MemberAvatar member={member} />
					</span>
					<span className="truncate">{member.name}</span>
					{member.role === "agent" && (
						<span className="ml-auto text-xs text-muted-foreground">Agent</span>
					)}
				</div>
			))}
		</div>
	) : null;

	return {
		menu,
		update,
		close: () => setTyping(null),
		onKeyDown,
		aria: {
			"aria-autocomplete": "list" as const,
			"aria-controls": open ? `${id}-menu` : undefined,
			"aria-activedescendant": open ? option(active) : undefined,
			// Read by dialogs, so that Escape closes the menu rather than the dialog.
			"data-mentioning": open ? "" : undefined,
		},
	};
}

/** For a dialog's `onEscapeKeyDown`: keeps it open when Escape is meant for a mention menu. */
export function keepOpenForMentions(event: globalThis.KeyboardEvent): void {
	if (event.target instanceof HTMLElement && event.target.hasAttribute("data-mentioning")) {
		event.preventDefault();
	}
}
