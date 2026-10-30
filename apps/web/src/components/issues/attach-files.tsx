import { Paperclip } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type RefObject, useRef } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import {
	attachmentMarkdown,
	attachmentName,
	attachmentPath,
	insertParagraph,
	MAX_FILE_BYTES,
} from "#/lib/attachments";

/**
 * Attaching files to a Markdown text box: pasting, dropping, or the attach button. Each file's
 * link goes in at the caret at once, and the file uploads behind it, so typing can go on.
 * Null in the demo, which keeps no files.
 */
export function useAttachFiles(
	textarea: RefObject<HTMLTextAreaElement | null>,
	setValue: (next: string) => void,
) {
	const { id: workspaceId, demo } = useWorkspace();
	if (demo) return null;

	function attach(files: readonly File[]) {
		const element = textarea.current;
		if (!element || files.length === 0) return;
		const markdown = startUploads(workspaceId, files);
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

/** Starts uploading what can be uploaded, and returns the Markdown that links it. */
function startUploads(workspaceId: string, files: readonly File[]): string | null {
	if (!navigator.onLine) {
		toast.error("You are offline", { description: "Attach files once you are back online." });
		return null;
	}
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
	const [only] = links;
	toast.promise(Promise.all(links.map(({ file, path }) => upload(path, file))), {
		loading:
			only && links.length === 1 ? `Uploading ${only.name}…` : `Uploading ${links.length} files…`,
		success:
			only && links.length === 1 ? `Attached ${only.name}` : `Attached ${links.length} files`,
		error: (error: unknown) => ({
			message: "Could not attach the file",
			description: `${error instanceof Error ? error.message : String(error)} Remove its link or try again.`,
		}),
	});
	return links.map(({ markdown }) => markdown).join("\n");
}

async function upload(path: string, file: File): Promise<void> {
	const response = await fetch(path, {
		method: "PUT",
		body: file,
		headers: { "Content-Type": file.type || "application/octet-stream" },
	});
	if (response.ok) return;
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	throw new Error(`${body?.error ?? `The server answered ${response.status}`}.`);
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
