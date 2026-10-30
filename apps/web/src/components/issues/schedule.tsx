import type { Issue } from "@gateweave/track-protocol";
import { CalendarClock, Gauge } from "lucide-react";
import { formatDay, formatShortDay } from "#/lib/dates";
import { estimateLabel, isIssueOverdue } from "#/lib/issues";
import { cn } from "#/lib/utils";

/** An issue's due date, in red once it has passed. Nothing when it has none. */
export function DueDate({
	issue,
	className,
}: {
	issue: Pick<Issue, "dueDate" | "status">;
	className?: string;
}) {
	if (!issue.dueDate) return null;
	const overdue = isIssueOverdue(issue);
	const label = `${overdue ? "Overdue, due" : "Due"} ${formatDay(issue.dueDate)}`;
	return (
		<span
			title={label}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums",
				overdue && "text-destructive",
				className,
			)}
		>
			<CalendarClock aria-hidden className="size-3.5" />
			<span className="sr-only">{label}</span>
			<span aria-hidden>{formatShortDay(issue.dueDate)}</span>
		</span>
	);
}

/** An issue's estimate in points. Nothing when it has none. */
export function Estimate({ estimate, className }: { estimate: number | null; className?: string }) {
	if (estimate === null) return null;
	const label = `Estimate: ${estimateLabel(estimate)}`;
	return (
		<span
			title={label}
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-xs text-muted-foreground tabular-nums",
				className,
			)}
		>
			<Gauge aria-hidden className="size-3" />
			<span className="sr-only">{label}</span>
			<span aria-hidden>{estimate}</span>
		</span>
	);
}
