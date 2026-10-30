import { ListTree } from "lucide-react";
import type { ProjectProgress } from "#/lib/projects";
import { cn } from "#/lib/utils";

/** How many of an issue's sub-issues are done, for lists and boards. Nothing without any. */
export function SubIssueCount({
	progress,
	className,
}: {
	progress: ProjectProgress | undefined;
	className?: string;
}) {
	if (!progress) return null;
	const label = `Sub-issues: ${progress.done} of ${progress.total} done`;
	return (
		<span
			title={label}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums",
				className,
			)}
		>
			<ListTree aria-hidden className="size-3.5" />
			<span className="sr-only">{label}</span>
			<span aria-hidden>
				{progress.done}/{progress.total}
			</span>
		</span>
	);
}
