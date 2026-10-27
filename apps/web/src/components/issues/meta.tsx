import type { IssuePriority, IssueStatus } from "@tangent/protocol";
import {
	Circle,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleDotDashed,
	CircleX,
	type LucideIcon,
	Minus,
	OctagonAlert,
	SignalHigh,
	SignalLow,
	SignalMedium,
} from "lucide-react";
import { cn } from "#/lib/utils";

interface Meta {
	label: string;
	icon: LucideIcon;
	className: string;
}

export const STATUS_META: Record<IssueStatus, Meta> = {
	backlog: { label: "Backlog", icon: CircleDashed, className: "text-muted-foreground" },
	todo: { label: "Todo", icon: Circle, className: "text-foreground/70" },
	in_progress: { label: "In Progress", icon: CircleDotDashed, className: "text-amber-500" },
	in_review: { label: "In Review", icon: CircleDot, className: "text-emerald-500" },
	done: { label: "Done", icon: CircleCheck, className: "text-indigo-500" },
	canceled: { label: "Canceled", icon: CircleX, className: "text-muted-foreground" },
};

export const PRIORITY_META: Record<IssuePriority, Meta> = {
	0: { label: "No priority", icon: Minus, className: "text-muted-foreground" },
	1: { label: "Urgent", icon: OctagonAlert, className: "text-orange-600 dark:text-orange-500" },
	2: { label: "High", icon: SignalHigh, className: "text-foreground/80" },
	3: { label: "Medium", icon: SignalMedium, className: "text-foreground/80" },
	4: { label: "Low", icon: SignalLow, className: "text-foreground/80" },
};

/** Priorities in the order people pick them: most urgent first, "none" last. */
export const PRIORITY_ORDER = [1, 2, 3, 4, 0] as const satisfies readonly IssuePriority[];

export function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
	const { icon: Icon, className: color, label } = STATUS_META[status];
	return <Icon aria-label={label} className={cn("size-4 shrink-0", color, className)} />;
}

export function PriorityIcon({
	priority,
	className,
}: {
	priority: IssuePriority;
	className?: string;
}) {
	const { icon: Icon, className: color, label } = PRIORITY_META[priority];
	return <Icon aria-label={label} className={cn("size-4 shrink-0", color, className)} />;
}
