import type { ProjectStatus } from "@gateweave/track-protocol";
import {
	Circle,
	CircleCheck,
	CircleDotDashed,
	CirclePause,
	CircleX,
	type LucideIcon,
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
