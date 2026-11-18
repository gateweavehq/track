import { type ReactNode, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";

/**
 * Asks before doing something that cannot be undone. `onConfirm` may be async; the dialog
 * stays open until it settles. A caller may keep Cancel usable for an operation that can block.
 */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	onConfirm,
	onClose,
	allowCancelWhilePending = false,
}: {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	onConfirm: () => Promise<void> | void;
	onClose: () => void;
	allowCancelWhilePending?: boolean;
}) {
	const [pending, setPending] = useState(false);
	const cancelled = useRef(false);

	async function confirm() {
		setPending(true);
		try {
			await onConfirm();
			if (!cancelled.current) onClose();
		} catch (error) {
			if (!allowCancelWhilePending) throw error;
		} finally {
			setPending(false);
		}
	}
	function cancel() {
		cancelled.current = true;
		onClose();
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => !open && (!pending || allowCancelWhilePending) && cancel()}
		>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{children}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={cancel} disabled={pending && !allowCancelWhilePending}>
						{pending && allowCancelWhilePending ? "Stop waiting" : "Cancel"}
					</Button>
					<Button variant="destructive" onClick={confirm} disabled={pending}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
