import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { uploadOutbox } from "#/lib/upload-outbox";

/** How often to try again while files wait and the browser says it is online. */
const RETRY_MS = 30_000;

/**
 * Uploads what waits in the browser's outbox: on opening the workspace, when the connection
 * comes back, and every so often while something waits. Says so when files that had to wait
 * are uploaded, or are refused for good. Renders nothing.
 */
export function UploadOutboxDrain({ userId }: { userId: string }) {
	useEffect(() => {
		const outbox = uploadOutbox();
		outbox.setUser(userId);
		let uploaded: string[] = [];
		let announce: ReturnType<typeof setTimeout> | undefined;
		// A file's first try is reported where it was attached; these are the ones that waited.
		const stop = outbox.onSettled((upload, result, first) => {
			if (first || result.status === "waiting") return;
			if (result.status === "failed") {
				refusedFile(upload.name, upload.blob, result.message, result.taken === true);
				return;
			}
			uploaded.push(upload.name);
			// One word for a drain's worth of files.
			clearTimeout(announce);
			announce = setTimeout(() => {
				const [only] = uploaded;
				toast.success(
					only && uploaded.length === 1
						? `Uploaded ${only}, which was waiting`
						: `Uploaded ${uploaded.length} files that were waiting`,
				);
				uploaded = [];
			}, 300);
		});
		const drain = () => {
			if (navigator.onLine) void outbox.drain();
		};
		void outbox.load().then(drain);
		window.addEventListener("online", drain);
		const timer = setInterval(() => {
			if (outbox.size > 0) drain();
		}, RETRY_MS);
		return () => {
			stop();
			clearTimeout(announce);
			clearInterval(timer);
			window.removeEventListener("online", drain);
		};
	}, [userId]);
	return null;
}

/**
 * Says a file was refused for good. When its link holds someone else's file, it offers the
 * person's own copy, which may be the only one, as with a pasted screenshot.
 */
export function refusedFile(name: string, blob: Blob, message: string, taken: boolean) {
	toast.error(`Could not attach ${name}`, {
		description: `${message} Remove its link or attach it again.`,
		...(taken && takenFile(name, blob)),
	});
}

/**
 * What a toast about a file whose link holds someone else's file adds: it stays until dismissed,
 * and offers to save the person's own copy, so they can attach it again under a new link.
 */
export function takenFile(name: string, blob: Blob) {
	return {
		duration: Number.POSITIVE_INFINITY,
		action: { label: "Save a copy", onClick: () => saveCopy(name, blob) },
	};
}

function saveCopy(name: string, blob: Blob) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const noop = () => () => {};

/** Whether an attached file is still waiting to upload, and a URL that shows it meanwhile. */
export function usePendingUpload(path: string | undefined): {
	waiting: boolean;
	preview: string | null;
} {
	const outbox = typeof window === "undefined" ? null : uploadOutbox();
	const waiting = useSyncExternalStore(
		outbox ? (listener) => outbox.subscribe(listener) : noop,
		() => (outbox && path ? outbox.pending(path).waiting : false),
		() => false,
	);
	const preview = useSyncExternalStore(
		outbox ? (listener) => outbox.subscribe(listener) : noop,
		() => (outbox && path ? outbox.pending(path).preview : null),
		() => null,
	);
	return { waiting, preview };
}
