import type { ProjectHealth, ProjectStatus } from "@gateweave/track-protocol";
import {
	Circle,
	CircleAlert,
	CircleCheck,
	CircleDotDashed,
	CirclePause,
	CircleX,
	type LucideIcon,
	OctagonAlert,
	TrendingUp,
} from "lucide-react";
import { cn } from "#/lib/utils";

interface Meta {
	label: string;
	icon: LucideIcon;
	className: string;
}

export const PROJECT_STATUS_META: Record<ProjectStatus, Meta> = {
	planned: { label: "Planned", icon: Circle, className: "text-muted-foreground" },
	started: { label: "In progress", icon: CircleDotDashed, className: "text-amber-500" },
	paused: { label: "Paused", icon: CirclePause, className: "text-muted-foreground" },
	completed: { label: "Completed", icon: CircleCheck, className: "text-indigo-500" },
	canceled: { label: "Canceled", icon: CircleX, className: "text-muted-foreground" },
};

export function ProjectStatusIcon({
	status,
	className,
}: {
	status: ProjectStatus;
	className?: string;
}) {
	const { icon: Icon, className: color, label } = PROJECT_STATUS_META[status];
	return <Icon aria-label={label} className={cn("size-4 shrink-0", color, className)} />;
}

/** A health is a status color, so it always comes with its icon and its words. */
export const HEALTH_META: Record<ProjectHealth, Meta> = {
	on_track: {
		label: "On track",
		icon: TrendingUp,
		className: "text-emerald-600 dark:text-emerald-500",
	},
	at_risk: { label: "At risk", icon: CircleAlert, className: "text-amber-500" },
	off_track: {
		label: "Off track",
		icon: OctagonAlert,
		className: "text-red-600 dark:text-red-500",
	},
};

export function ProjectHealthBadge({
	health,
	className,
}: {
	health: ProjectHealth;
	className?: string;
}) {
	const { icon: Icon, className: color, label } = HEALTH_META[health];
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium",
				className,
			)}
		>
			<Icon aria-hidden className={cn("size-3.5", color)} />
			{label}
		</span>
	);
}
