// Turns the sample data into the mutations that fill a workspace. `pnpm dev:seed` sends them
// through the sync gateway; the demo sends them to the Durable Object directly. Pure: no Node or
// Worker APIs, so both can use it.
import { type Cycle, cycleState, type MutationInput, type Team } from "@gateweave/track-protocol";
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
	/**
	 * Plans an issue into its team's current cycle. The cycle gets its id from the workspace when
	 * cycles are turned on, so the step holds a placeholder: the caller reads `currentCycleId` once
	 * the earlier steps are applied and sends `withCycle(step, id)`.
	 */
	needsCycle?: true;
}

const CYCLE_PLACEHOLDER = "current-cycle";

/** The step to send for one that `needsCycle`, with the cycle's real id. */
export function withCycle(step: SampleStep, cycleId: string): SampleStep {
	const { mutation } = step;
	if (!step.needsCycle || mutation.name !== "issue.update") return step;
	return {
		person: step.person,
		mutation: { ...mutation, args: { ...mutation.args, patch: { cycleId } } },
	};
}

/**
 * The id of the Engineering team's cycle running on `now`, from a workspace's teams and cycles
 * (a Durable Object's `directory()` or a client's replica). Throws when there is none, which
 * means the steps before the `needsCycle` ones were not applied.
 */
export function currentCycleId(
	{ teams, cycles }: { teams: Iterable<Pick<Team, "id" | "key">>; cycles: Iterable<Cycle> },
	now = new Date(),
): string {
	const team = [...teams].find((candidate) => candidate.key === CYCLE_TEAM);
	const today = now.toISOString().slice(0, 10);
	const cycle = [...cycles].find(
		(candidate) => candidate.teamId === team?.id && cycleState(candidate, today) === "current",
	);
	if (!cycle) throw new Error(`The ${CYCLE_TEAM} team has no current cycle`);
	return cycle.id;
}

const CYCLE_TEAM: TeamKey = "ENG";

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
				id: teamIds[CYCLE_TEAM],
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
	// Planned after creation, once the cycle is known. The creator makes the edit, so it never
	// conflicts with the issue's own fields.
	for (const { id, issue } of sample) {
		if (issue.cycle !== "current") continue;
		steps.push({
			person: issue.by,
			needsCycle: true,
			mutation: {
				name: "issue.update",
				args: { id, baseVersion: 0, patch: { cycleId: CYCLE_PLACEHOLDER } },
			},
		});
	}
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
