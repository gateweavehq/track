import { Paperclip } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type RefObject, useRef } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { refusedFile, takenFile } from "#/components/workspace/upload-outbox";
import {
	attachmentMarkdown,
	attachmentName,
	attachmentPath,
	insertParagraph,
	MAX_FILE_BYTES,
} from "#/lib/attachments";
import { type Refusal, refusals, uploadOutbox } from "#/lib/upload-outbox";

/**
 * Attaching files to a Markdown text box: pasting, dropping, or the attach button. Each file's
 * link goes in at the caret at once, and the file uploads behind it, so typing can go on.
 * Null in the demo, which keeps no files.
 */
export function useAttachFiles(
	textarea: RefObject<HTMLTextAreaElement | null>,
	setValue: (next: string) => void,
) {
	const { id: workspaceId, userId, demo } = useWorkspace();
	if (demo) return null;

	function attach(files: readonly File[]) {
		const element = textarea.current;
		if (!element || files.length === 0) return;
		const markdown = startUploads(workspaceId, userId, files);
		if (!markdown) return;
		const { value, caret } = insertParagraph(
			element.value,
			element.selectionStart,
			element.selectionEnd,
			markdown,
		);
		setValue(value);
		requestAnimationFrame(() => {
			element.focus();
			element.setSelectionRange(caret, caret);
		});
	}

	return {
		attach,
		/** For the text box itself. */
		handlers: {
			onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
				// Copying from an office app brings a picture of the text along; the text is meant.
				if (event.clipboardData.types.includes("text/plain")) return;
				const files = [...event.clipboardData.files];
				if (files.length === 0) return;
				event.preventDefault();
				attach(files);
			},
			onDragOver(event: DragEvent<HTMLTextAreaElement>) {
				if (event.dataTransfer.types.includes("Files")) event.preventDefault();
			},
			onDrop(event: DragEvent<HTMLTextAreaElement>) {
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				attach(files);
			},
		},
	};
}

/**
 * Starts uploading what can be uploaded, and returns the Markdown that links it. Offline, or when
 * an upload cannot get through, the file waits in the browser's outbox and uploads later.
 */
function startUploads(workspaceId: string, userId: string, files: readonly File[]): string | null {
	const accepted = files.filter((file) => {
		if (file.size === 0) toast.error(`${file.name} is empty`);
		else if (file.size > MAX_FILE_BYTES) {
			toast.error(`${file.name} is too large`, {
				description: `Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
			});
		} else return true;
		return false;
	});
	if (accepted.length === 0) return null;

	const links = accepted.map((file) => {
		const name = attachmentName(file.name);
		const path = attachmentPath(workspaceId, crypto.randomUUID(), name);
		return { file, name, path, markdown: attachmentMarkdown(name, path, file.type) };
	});
	const outbox = uploadOutbox();
	const results = links.map(({ file, name, path }) =>
		outbox.add({
			path,
			workspaceId,
			userId,
			name,
			type: file.type,
			blob: file,
			createdAt: Date.now(),
		}),
	);
	const [only] = links;
	const what = only && links.length === 1 ? only.name : `${links.length} files`;
	const refused = ({ item, message, taken }: Refusal<(typeof links)[number]>) =>
		refusedFile(item.name, item.file, message, taken);
	if (!navigator.onLine) {
		toast(`${what} will upload when you are back online`, {
			description: "The link is in the text already.",
		});
		// The browser can be wrong about the connection. A first try that gets through all the
		// same settles here, not in the outbox's drain, which reports only files that waited.
		void Promise.all(results).then((outcomes) => {
			for (const refusal of refusals(links, outcomes)) refused(refusal);
		});
		return links.map(({ markdown }) => markdown).join("\n");
	}
	toast.promise(
		Promise.all(results).then((outcomes) => {
			// The first refusal is this toast's; each other one gets its own, so that no file whose
			// link was taken goes without its copy offered.
			const [first, ...others] = refusals(links, outcomes);
			for (const refusal of others) refused(refusal);
			if (first) throw new AttachError(first.message, first.taken ? first.item.file : undefined);
			return outcomes.some((outcome) => outcome.status === "waiting");
		}),
		{
			loading: `Uploading ${what}…`,
			success: (waiting) =>
				waiting ? `${what} will upload once the connection is back` : `Attached ${what}`,
			error: (error: unknown) => ({
				message: "Could not attach the file",
				description: `${error instanceof Error ? error.message : String(error)} Remove its link or try again.`,
				...(error instanceof AttachError &&
					error.taken &&
					takenFile(error.taken.name, error.taken)),
			}),
		},
	);
	return links.map(({ markdown }) => markdown).join("\n");
}

/** An upload refused for good; `taken` is the file when its link holds someone else's. */
class AttachError extends Error {
	readonly taken: File | undefined;
	constructor(message: string, taken: File | undefined) {
		super(message);
		this.taken = taken;
	}
}

/** Opens the file picker. The caret stays in the text box, where the links go. */
export function AttachButton({
	label,
	onFiles,
}: {
	label: string;
	onFiles: (files: File[]) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-7 text-muted-foreground"
				aria-label={label}
				title={label}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => input.current?.click()}
			>
				<Paperclip />
			</Button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				tabIndex={-1}
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					// The same file can be picked again.
					event.target.value = "";
					onFiles(files);
				}}
			/>
		</>
	);
}
