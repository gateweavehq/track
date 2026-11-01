import type {
	Issue,
	IssuePriority,
	StatusCategory,
	WorkflowStatus,
} from "@gateweave/track-protocol";
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
import { useIssueStatus } from "#/lib/queries";
import { cn } from "#/lib/utils";

interface Meta {
	label: string;
	icon: LucideIcon;
	className: string;
}

/** A status's mark says its category; its color is its own. */
const CATEGORY_ICONS: Record<StatusCategory, LucideIcon> = {
	backlog: CircleDashed,
	unstarted: Circle,
	started: CircleDotDashed,
	completed: CircleCheck,
	canceled: CircleX,
};

/** The theme's color for a status without one of its own. */
const NEUTRAL_COLORS: Record<StatusCategory, string> = {
	backlog: "text-muted-foreground",
	unstarted: "text-foreground/70",
	started: "text-foreground/70",
	completed: "text-foreground/70",
	canceled: "text-muted-foreground",
};

export type StatusLook = Pick<WorkflowStatus, "key" | "name" | "category" | "color">;

function statusIcon(status: StatusLook): LucideIcon {
	// The built-in In Review keeps the mark of a step past In Progress.
	if (status.key === "in_review" && status.category === "started") return CircleDot;
	return CATEGORY_ICONS[status.category];
}

export const PRIORITY_META: Record<IssuePriority, Meta> = {
	0: { label: "No priority", icon: Minus, className: "text-muted-foreground" },
	1: { label: "Urgent", icon: OctagonAlert, className: "text-orange-600 dark:text-orange-500" },
	2: { label: "High", icon: SignalHigh, className: "text-foreground/80" },
	3: { label: "Medium", icon: SignalMedium, className: "text-foreground/80" },
	4: { label: "Low", icon: SignalLow, className: "text-foreground/80" },
};

/** Priorities in the order people pick them: most urgent first, "none" last. */
export const PRIORITY_ORDER = [1, 2, 3, 4, 0] as const satisfies readonly IssuePriority[];

export function StatusIcon({ status, className }: { status: StatusLook; className?: string }) {
	const Icon = statusIcon(status);
	return (
		<Icon
			aria-label={status.name}
			className={cn(
				"size-4 shrink-0",
				status.color === null && NEUTRAL_COLORS[status.category],
				className,
			)}
			style={status.color === null ? undefined : { color: status.color }}
		/>
	);
}

/** The icon of the status an issue is in, as its team has it. */
export function IssueStatusIcon({
	issue,
	className,
}: {
	issue: Pick<Issue, "teamId" | "status">;
	className?: string;
}) {
	return <StatusIcon status={useIssueStatus(issue)} className={className} />;
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
