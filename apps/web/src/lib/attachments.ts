// Files people attach to descriptions and comments. They live in R2 under the workspace's id and
// are linked from the Markdown by a path of this app, so whoever opens the link must be signed in
// as a member. These helpers are shared by the browser and the gateway (`server/files.ts`).

/** The largest file that can be attached. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const MAX_NAME_LENGTH = 100;

/** Characters that cannot be in a file's name: path separators, controls, and URL syntax. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const UNSAFE = /[\u0000-\u001f\u007f/\\?#%"<>|:*]+/g;

/**
 * A file's name as its link carries it: what it was called, without characters that are unsafe
 * in a path or a header, at most 100 characters with the extension kept. The gateway accepts a
 * name only when it is already in this form.
 */
export function attachmentName(name: string): string {
	const cleaned = name
		.normalize("NFC")
		.replace(UNSAFE, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	if (!cleaned) return "file";
	const chars = [...cleaned];
	if (chars.length <= MAX_NAME_LENGTH) return cleaned;
	const dot = cleaned.lastIndexOf(".");
	const extension = dot > 0 ? [...cleaned.slice(dot)] : [];
	if (extension.length > 10) return chars.slice(0, MAX_NAME_LENGTH).join("");
	return chars.slice(0, MAX_NAME_LENGTH - extension.length).join("") + extension.join("");
}

/** Ids are UUIDs the browser makes, so a link can be written before its file is uploaded. */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isFileId(value: string): boolean {
	return FILE_ID.test(value);
}

/** The app's path to a file. Parentheses are encoded too, so the path is safe in a Markdown link. */
export function attachmentPath(workspaceId: string, fileId: string, name: string): string {
	const encoded = encodeURIComponent(name).replace(
		/[()'!*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `/api/files/${encodeURIComponent(workspaceId)}/${fileId}/${encoded}`;
}

/** Whether a link's target is a file attached in this app. Only those show as images. */
export function isAttachmentPath(url: string): boolean {
	return url.startsWith("/api/files/");
}

/** Images every browser shows. SVG is not one of them here: it can carry scripts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Types the gateway lets a browser show in place. Everything else is downloaded. */
const INLINE_TYPES = new Set([
	...IMAGE_TYPES,
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/ogg",
	"audio/wav",
	"text/plain",
]);

export function isImageType(type: string): boolean {
	return IMAGE_TYPES.has(type);
}

export function isInlineType(type: string): boolean {
	return INLINE_TYPES.has(type);
}

/** The Markdown that links a file: an image for images, a link for anything else. */
export function attachmentMarkdown(name: string, path: string, type: string): string {
	const label = name.replace(/[\\[\]]/g, (char) => `\\${char}`);
	return isImageType(type) ? `![${label}](${path})` : `[${label}](${path})`;
}

/**
 * `text` put in a text box's value in place of the selection, as a paragraph of its own, and
 * where the caret goes after it. A blank line on each side keeps it out of a list or table that
 * it would otherwise continue.
 */
export function insertParagraph(
	value: string,
	start: number,
	end: number,
	text: string,
): { value: string; caret: number } {
	const before = value.slice(0, start);
	const after = value.slice(end);
	const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
	const trail = !after || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
	return {
		value: `${before}${lead}${text}${trail}${after}`,
		caret: before.length + lead.length + text.length,
	};
}
