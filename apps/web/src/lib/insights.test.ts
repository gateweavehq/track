import {
	type Activity,
	defaultStatuses,
	type Issue,
	startOfDay,
	type WorkflowStatus,
} from "@gateweave/track-protocol";
import { describe, expect, it } from "vitest";
import { formatDays, projectInsights, teamInsights, weekStart } from "./insights";

const ZONE = "Europe/Istanbul";
const HOUR = 60 * 60 * 1000;
const at = (day: string, hour = 12) => startOfDay(ZONE, day) + hour * HOUR;
// A Wednesday: the range's last week starts on Monday 2026-11-02.
const NOW = at("2026-11-04");

const qa: WorkflowStatus = {
	id: "t1/qa",
	teamId: "t1",
	key: "qa",
	name: "QA",
	category: "started",
	color: null,
	sortOrder: "a2",
	createdAt: 0,
	updatedAt: 0,
	removedAt: null,
};
const shipped: WorkflowStatus = {
	...qa,
	id: "t1/shipped",
	key: "shipped",
	name: "Shipped",
	category: "completed",
	sortOrder: "a1",
	// Removed since: history that names it still reads as completed.
	removedAt: 1,
};
const statuses = new Map(
	[...defaultStatuses("t1", 0), ...defaultStatuses("t2", 0), qa, shipped].map((status) => [
		status.id,
		status,
	]),
);

function issue(id: string, fields: Partial<Issue> = {}): Issue {
	return {
		id,
		teamId: "t1",
		number: 1,
		title: id,
		description: null,
		status: "todo",
		priority: 0,
		assigneeId: null,
		creatorId: "u1",
		projectId: null,
		cycleId: null,
		parentId: null,
		startDate: null,
		dueDate: null,
		estimate: null,
		labelIds: [],
		sortOrder: "a0",
		version: 1,
		createdAt: at("2026-10-20"),
		updatedAt: 0,
		archivedAt: null,
		...fields,
	};
}

let next = 0;
function moved(issueId: string, from: string, to: string, time: number): Activity {
	next += 1;
	return {
		id: `a${next}`,
		issueId,
		actorId: "u1",
		change: { type: "status", from, to },
		proposedBy: null,
		source: null,
		createdAt: time,
		updatedAt: time,
	};
}

describe("teamInsights", () => {
	it("counts what was created and closed each week, the archived and reopened included", () => {
		const issues = [
			issue("old", { createdAt: at("2026-08-01"), status: "done" }),
			issue("a", { createdAt: at("2026-10-27"), status: "done", archivedAt: at("2026-11-03") }),
			issue("b", { createdAt: at("2026-11-02", 9), status: "canceled" }),
			issue("c", { createdAt: at("2026-11-03"), status: "todo" }),
			// Filed as done, as an import does: closed when it was created.
			issue("filed", { createdAt: at("2026-10-26", 9), status: "done" }),
			issue("other", { teamId: "t2", createdAt: at("2026-11-03"), status: "done" }),
		];
		const activities = [
			moved("old", "todo", "done", at("2026-08-02")),
			moved("a", "todo", "done", at("2026-10-28")),
			moved("a", "done", "todo", at("2026-10-29")),
			moved("a", "todo", "done", at("2026-11-02")),
			moved("b", "backlog", "canceled", at("2026-11-02", 10)),
			// From one closed status to another is not another close.
			moved("b", "done", "canceled", at("2026-11-03")),
			moved("other", "todo", "done", at("2026-11-03")),
		];
		const insights = teamInsights({
			teamId: "t1",
			issues,
			activities,
			statuses,
			timeZone: ZONE,
			now: NOW,
			weeks: 4,
		});
		expect(insights.weeks).toEqual([
			{ start: "2026-10-12", created: 0, closed: 0 },
			{ start: "2026-10-19", created: 0, closed: 0 },
			{ start: "2026-10-26", created: 2, closed: 2 },
			{ start: "2026-11-02", created: 2, closed: 2 },
		]);
		expect(insights).toMatchObject({ created: 4, closed: 4, open: 1 });
	});

	it("measures cycle time from the first start to the completion that stands", () => {
		const issues = [
			issue("fast", { status: "done" }),
			issue("slow", { status: "shipped" }),
			issue("never-started", { status: "done" }),
			issue("reopened", { status: "in_progress" }),
			issue("before", { status: "done" }),
			// Filed straight into In Progress, so started when it was created.
			issue("filed-started", { status: "done", createdAt: at("2026-11-01", 12) }),
		];
		const activities = [
			moved("fast", "todo", "in_progress", at("2026-11-02", 9)),
			moved("fast", "in_progress", "done", at("2026-11-02", 15)),
			moved("slow", "todo", "qa", at("2026-10-26", 12)),
			moved("slow", "qa", "in_progress", at("2026-10-27", 12)),
			moved("slow", "in_progress", "shipped", at("2026-10-30", 12)),
			// Moving between completed statuses keeps when it was done.
			moved("slow", "shipped", "done", at("2026-11-03", 12)),
			moved("never-started", "todo", "done", at("2026-11-02")),
			moved("reopened", "in_progress", "done", at("2026-11-02")),
			moved("reopened", "done", "in_progress", at("2026-11-03")),
			moved("before", "todo", "in_progress", at("2026-08-01")),
			moved("before", "in_progress", "done", at("2026-08-02")),
			moved("filed-started", "in_progress", "done", at("2026-11-03", 12)),
		];
		const insights = teamInsights({
			teamId: "t1",
			issues,
			activities,
			statuses,
			timeZone: ZONE,
			now: NOW,
			weeks: 4,
		});
		// 0.25, 2 and 4 days.
		expect(insights.cycleTime).toEqual({ medianDays: 2, issues: 3 });
	});

	it("breaks open issues down by status, assignee and label", () => {
		const issues = [
			issue("a", { status: "qa", assigneeId: "u1", labelIds: ["bug", "ui"] }),
			issue("b", { status: "todo", assigneeId: "u1", labelIds: ["bug"] }),
			issue("c", { status: "todo", assigneeId: null, labelIds: [] }),
			issue("d", { status: "backlog", assigneeId: "u2", labelIds: ["ui", "bug"] }),
			issue("done", { status: "done", assigneeId: "u2", labelIds: ["bug"] }),
		];
		const insights = teamInsights({
			teamId: "t1",
			issues,
			activities: [],
			statuses,
			timeZone: ZONE,
			now: NOW,
			weeks: 4,
		});
		expect(insights.open).toBe(4);
		expect(insights.byStatus.map(({ key, count }) => [key.key, count])).toEqual([
			["backlog", 1],
			["todo", 2],
			["qa", 1],
		]);
		expect(insights.byAssignee).toEqual([
			{ key: "u1", count: 2 },
			{ key: null, count: 1 },
			{ key: "u2", count: 1 },
		]);
		expect(insights.byLabel).toEqual([
			{ key: "bug", count: 3 },
			{ key: "ui", count: 2 },
		]);
		expect(insights.cycleTime).toEqual({ medianDays: null, issues: 0 });
	});
});

describe("projectInsights", () => {
	it("counts a project's issues from every team, each by its own team's statuses", () => {
		const issues = [
			// Engineering's own "QA" status is a started one.
			issue("eng", { projectId: "p1", status: "done", assigneeId: "u1" }),
			issue("ops", { projectId: "p1", teamId: "t2", status: "in_progress", assigneeId: "u1" }),
			issue("ops-open", { projectId: "p1", teamId: "t2", status: "todo", labelIds: ["bug"] }),
			issue("elsewhere", { projectId: "p2", status: "todo" }),
			issue("none", { status: "todo" }),
		];
		const activities = [
			moved("eng", "todo", "qa", at("2026-10-30", 12)),
			moved("eng", "qa", "done", at("2026-11-02", 12)),
		];
		const insights = projectInsights({
			projectId: "p1",
			issues,
			activities,
			statuses,
			timeZone: ZONE,
			now: NOW,
			weeks: 4,
		});
		expect(insights).toMatchObject({ created: 3, closed: 1, open: 2 });
		expect(insights.cycleTime).toEqual({ medianDays: 3, issues: 1 });
		expect(insights.byTeam).toEqual([{ key: "t2", count: 2 }]);
		expect(insights.byAssignee).toEqual([
			{ key: "u1", count: 1 },
			{ key: null, count: 1 },
		]);
		expect(insights.byLabel).toEqual([{ key: "bug", count: 1 }]);
		expect(insights).not.toHaveProperty("openIssues");
	});
});

describe("weekStart", () => {
	it("goes back to Monday", () => {
		expect(weekStart("2026-11-04")).toBe("2026-11-02");
		expect(weekStart("2026-11-02")).toBe("2026-11-02");
		expect(weekStart("2026-11-01")).toBe("2026-10-26");
	});
});

describe("formatDays", () => {
	it("says under an hour, then hours under a day, then days", () => {
		expect(formatDays(0.01)).toBe("under an hour");
		expect(formatDays(0.05)).toBe("1 hour");
		expect(formatDays(0.25)).toBe("6 hours");
		expect(formatDays(1)).toBe("1 day");
		expect(formatDays(2.125)).toBe("2.1 days");
		expect(formatDays(14.6)).toBe("15 days");
	});
});
