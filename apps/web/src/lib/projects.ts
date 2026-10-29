import type { Issue, Project, ProjectStatus } from "@gateweave/track-protocol";

/** The order projects are listed in: work in flight first, finished work last. */
export const PROJECT_STATUS_ORDER = [
	"started",
	"planned",
	"paused",
	"completed",
	"canceled",
] as const satisfies readonly ProjectStatus[];

export function compareProjects(
	a: Pick<Project, "id" | "name" | "status">,
	b: Pick<Project, "id" | "name" | "status">,
): number {
	const byStatus = PROJECT_STATUS_ORDER.indexOf(a.status) - PROJECT_STATUS_ORDER.indexOf(b.status);
	if (byStatus !== 0) return byStatus;
	const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	if (byName !== 0) return byName;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** How far along a project is: issues done, out of all that are not canceled. */
export interface ProjectProgress {
	done: number;
	/** Every issue that is not canceled. */
	total: number;
}

export function projectProgress(issues: Iterable<Pick<Issue, "status">>): ProjectProgress {
	let done = 0;
	let total = 0;
	for (const { status } of issues) {
		if (status === "canceled") continue;
		total += 1;
		if (status === "done") done += 1;
	}
	return { done, total };
}

/** A whole percentage for a progress bar. A project with nothing to do yet is at zero. */
export function progressPercent({ done, total }: ProjectProgress): number {
	return total === 0 ? 0 : Math.round((done / total) * 100);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** "Dec 31, 2026" for a `YYYY-MM-DD` date, read as a day on the calendar in any time zone. */
export function formatTargetDate(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	if (!year || !month || !day) return date;
	return dateFormat.format(new Date(year, month - 1, day));
}

/** The day `now` falls on, as `YYYY-MM-DD` in the viewer's time zone. */
export function today(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** True when the target date has passed and the project is still open. */
export function isOverdue(
	project: Pick<Project, "status" | "targetDate">,
	now = new Date(),
): boolean {
	if (project.targetDate === null) return false;
	if (project.status === "completed" || project.status === "canceled") return false;
	// ISO dates compare as text.
	return project.targetDate < today(now);
}
