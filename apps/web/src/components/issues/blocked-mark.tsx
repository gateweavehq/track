import { Ban } from "lucide-react";
import { cn } from "#/lib/utils";

/** Marks an open issue that an open issue blocks, for lists and boards. */
export function BlockedMark({ blocked, className }: { blocked: boolean; className?: string }) {
	if (!blocked) return null;
	return (
		<span
			title="Blocked by an open issue"
			className={cn("inline-flex shrink-0 items-center text-destructive", className)}
		>
			<Ban aria-hidden className="size-3.5" />
			<span className="sr-only">Blocked</span>
		</span>
	);
}
