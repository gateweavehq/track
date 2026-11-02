import { z } from "zod";

/**
 * Why a text was refused. NUL characters and lone surrogates are invisible, so the message names
 * them rather than leaving people to guess what is wrong with text that looks fine.
 */
export const MALFORMED_TEXT =
	"Text must not contain NUL characters or unpaired surrogates (broken emoji)";

/**
 * Whether text can be stored as written. A NUL confuses SQLite's `length` and `glob`, and a lone
 * surrogate is stored as three bytes that read back as U+FFFD, so the text would change silently.
 */
export function isWellFormedText(text: string): boolean {
	return !text.includes("\0") && text.isWellFormed();
}

/**
 * Text made storable, for text that comes from people or mail rather than a client that knows
 * the rules: NUL characters are dropped and lone surrogates become U+FFFD, as storing them would.
 */
export function cleanText(text: string): string {
	return text.replaceAll("\0", "").toWellFormed();
}

/**
 * The first `max` UTF-16 units of `text`, one fewer where the cut would split a surrogate pair:
 * `slice` alone would leave half an emoji, a lone surrogate the protocol refuses.
 */
export function cutText(text: string, max: number): string {
	const last = text.charCodeAt(max - 1);
	const splits = last >= 0xd800 && last <= 0xdbff && text.length > max;
	return text.slice(0, splits ? max - 1 : max);
}

/** A string of user text. Every free-text field of the protocol starts from it. */
export const userText = z.string().refine(isWellFormedText, MALFORMED_TEXT);
