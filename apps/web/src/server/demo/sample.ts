// Turns the sample data into the mutations that fill a workspace. `pnpm dev:seed` sends them
// through the sync gateway; the demo sends them to the Durable Object directly. Pure: no Node or
// Worker APIs, so both can use it.
import type { MutationInput } from "@gateweave/track-protocol";
import { generateNKeysBetween } from "fractional-indexing";
import {
	generatedIssues,
	ISSUES,
	LABELS,
	type LabelKey,
	PEOPLE,
	type PersonKey,
	PROJECTS,
	type ProjectKey,
	type SampleIssue,
	TEAMS,
	type TeamKey,
} from "./sample-data";

export * from "./sample-data";

/** One write, made as one of the sample people. */
export interface SampleStep {
	person: PersonKey;
	mutation: MutationInput;
	/** True when order does not matter, so a caller may send such steps at once. */
	parallel?: true;
}

export interface SampleOptions {
	/** The user id of each sample person, which issues are assigned to and projects are led by. */
	userIds: Record<PersonKey, string>;
	/** A fresh entity id. */
	newId: () => string;
	/** Extra generated issues after the sample ones, for load testing. */
	extraIssues?: number;
	/** The day target dates are counted from. */
	now?: Date;
}

/**
 * Every write that builds the sample workspace, in an order that is valid: teams and labels
 * first (only admins create them, and turn on Engineering's two-week cycles), then the projects, then the issues in listed order so they
 * are numbered that way, then their comments, then any generated filler.
 */
export function sampleSteps({
	userIds,
	newId,
	extraIssues = 0,
	now = new Date(),
}: SampleOptions): SampleStep[] {
	const maya: PersonKey = "maya";
	const steps: SampleStep[] = [];

	const teamIds = {} as Record<TeamKey, string>;
	for (const [key, name] of Object.entries(TEAMS) as [TeamKey, string][]) {
		teamIds[key] = newId();
		steps.push({
			person: maya,
			mutation: { name: "team.create", args: { id: teamIds[key], key, name } },
		});
	}

	// Its first cycle started this week, so the demo has one running.
	steps.push({
		person: maya,
		mutation: {
			name: "team.update",
			args: {
				id: teamIds.ENG,
				patch: { cycles: { weeks: 2, timeZone: "UTC", startsOn: mondayOf(now) } },
			},
		},
	});

	const labelIds = {} as Record<LabelKey, string>;
	for (const [key, label] of Object.entries(LABELS) as [LabelKey, (typeof LABELS)[LabelKey]][]) {
		labelIds[key] = newId();
		steps.push({
			person: maya,
			mutation: { name: "label.create", args: { id: labelIds[key], ...label } },
		});
	}

	const projectIds = {} as Record<ProjectKey, string>;
	for (const [key, project] of Object.entries(PROJECTS) as [
		ProjectKey,
		(typeof PROJECTS)[ProjectKey],
	][]) {
		projectIds[key] = newId();
		steps.push({
			person: maya,
			mutation: {
				name: "project.create",
				args: {
					id: projectIds[key],
					name: project.name,
					description: project.description,
					status: project.status,
					leadId: project.lead && userIds[project.lead],
					targetDate: project.targetInDays === null ? null : dayFrom(now, project.targetInDays),
				},
			},
		});
	}

	const issues = [...ISSUES, ...generatedIssues(extraIssues)];
	// Each team's issues are ordered as listed, with fractional sort keys like the app's own.
	const sortKeys = new Map<TeamKey, string[]>();
	for (const team of Object.keys(TEAMS) as TeamKey[]) {
		const count = issues.filter((issue) => issue.team === team).length;
		sortKeys.set(team, generateNKeysBetween(null, null, count));
	}

	const created = issues.map((issue, index) => {
		const sortOrder = sortKeys.get(issue.team)?.shift();
		if (!sortOrder) throw new Error("Ran out of sort keys");
		const id = newId();
		const step: SampleStep = {
			person: issue.by,
			mutation: issueCreate(issue, id, sortOrder, teamIds, labelIds, projectIds, userIds),
			...(index >= ISSUES.length && { parallel: true as const }),
		};
		return { id, issue, step };
	});

	const sample = created.slice(0, ISSUES.length);
	steps.push(...sample.map(({ step }) => step));
	// A comment at a time, so each thread reads in the order it is listed.
	for (const { id, issue } of sample) {
		for (const comment of issue.comments ?? []) {
			steps.push({
				person: comment.by,
				mutation: {
					name: "comment.create",
					args: { id: newId(), issueId: id, body: comment.body },
				},
			});
		}
	}
	steps.push(...created.slice(ISSUES.length).map(({ step }) => step));
	return steps;
}

function issueCreate(
	issue: SampleIssue,
	id: string,
	sortOrder: string,
	teamIds: Record<TeamKey, string>,
	labelIds: Record<LabelKey, string>,
	projectIds: Record<ProjectKey, string>,
	userIds: Record<PersonKey, string>,
): MutationInput {
	return {
		name: "issue.create",
		args: {
			id,
			teamId: teamIds[issue.team],
			title: issue.title,
			description: issue.description ?? null,
			status: issue.status,
			priority: issue.priority,
			assigneeId: issue.assignee && userIds[issue.assignee],
			projectId: issue.project ? projectIds[issue.project] : null,
			labelIds: (issue.labels ?? []).map((key) => labelIds[key]),
			sortOrder,
		},
	};
}

/** `YYYY-MM-DD`, `days` after the day `from` falls on in UTC. */
function dayFrom(from: Date, days: number): string {
	return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of the Monday on or before the day `from` falls on in UTC. */
function mondayOf(from: Date): string {
	return dayFrom(from, -((from.getUTCDay() + 6) % 7));
}

/** The people a sample workspace has, with the role each holds there. */
export const SAMPLE_PEOPLE = Object.entries(PEOPLE) as [PersonKey, (typeof PEOPLE)[PersonKey]][];
