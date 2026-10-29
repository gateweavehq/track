// Sample content for `pnpm dev:seed` and for the public demo's sandboxes: a small product
// company with a few people, teams and issues in every state. Names and addresses are fictional;
// example.com never receives mail. Pure data, no Node or Worker APIs (see sample.ts).
import type {
	IssuePriority,
	IssueStatus,
	PersonRole,
	ProjectStatus,
} from "@gateweave/track-protocol";

export const WORKSPACE_NAME = "Acme";

export type PersonKey = "maya" | "sam" | "lena" | "diego";

export interface Person {
	name: string;
	email: string;
	role: PersonRole;
}

export const PEOPLE: Record<PersonKey, Person> = {
	maya: { name: "Maya Chen", email: "maya@example.com", role: "owner" },
	sam: { name: "Sam Okafor", email: "sam@example.com", role: "admin" },
	lena: { name: "Lena Fischer", email: "lena@example.com", role: "member" },
	diego: { name: "Diego Ramos", email: "diego@example.com", role: "member" },
};

export type TeamKey = "ENG" | "DES" | "GRO";

export const TEAMS: Record<TeamKey, string> = {
	ENG: "Engineering",
	DES: "Design",
	GRO: "Growth",
};

export type LabelKey =
	| "bug"
	| "feature"
	| "improvement"
	| "performance"
	| "security"
	| "accessibility"
	| "docs";

export const LABELS: Record<LabelKey, { name: string; color: string }> = {
	bug: { name: "Bug", color: "#e5484d" },
	feature: { name: "Feature", color: "#0090ff" },
	improvement: { name: "Improvement", color: "#12a594" },
	performance: { name: "Performance", color: "#f76b15" },
	security: { name: "Security", color: "#6e56cf" },
	accessibility: { name: "Accessibility", color: "#46a758" },
	docs: { name: "Docs", color: "#8d8d8d" },
};

export type ProjectKey = "launch" | "reliability" | "polish";

export interface SampleProject {
	name: string;
	description: string;
	status: ProjectStatus;
	lead: PersonKey | null;
	/** Days from now to the target date, so the sample never goes stale. */
	targetInDays: number | null;
}

export const PROJECTS: Record<ProjectKey, SampleProject> = {
	launch: {
		name: "Public launch",
		description:
			"Everything between a working product and the first thousand visitors: the site, " +
			"the guides, the demo and the launch post.",
		status: "started",
		lead: "maya",
		targetInDays: 45,
	},
	reliability: {
		name: "Sync reliability",
		description: "Sign-in, sync and speed on large workspaces, so edits are never lost.",
		status: "started",
		lead: "sam",
		targetInDays: 21,
	},
	polish: {
		name: "Design polish",
		description: "Layouts, empty states and accessibility across the app.",
		status: "planned",
		lead: "diego",
		targetInDays: null,
	},
};

export interface SampleIssue {
	project?: ProjectKey;
	team: TeamKey;
	title: string;
	labels?: LabelKey[];
	status: IssueStatus;
	priority: IssuePriority;
	assignee: PersonKey | null;
	by: PersonKey;
	description?: string;
	/** A thread, in the order it was written. */
	comments?: { by: PersonKey; body: string }[];
}

export const ISSUES: SampleIssue[] = [
	{
		team: "ENG",
		title: "Sign-in fails when the email has uppercase letters",
		project: "reliability",
		labels: ["bug"],
		status: "in_progress",
		priority: 1,
		assignee: "sam",
		by: "lena",
		description:
			"Signing up as Lena@acme.test works, but signing in with the same address fails with " +
			"'Invalid email or password'. Lowercase works.\n\nNormalize the address on both paths and " +
			"add a test for mixed case.",
		comments: [
			{
				by: "sam",
				body: "Reproduced. Sign-up keeps the address as typed, but sign-in lowercases it first. Fixing both paths.",
			},
			{
				by: "lena",
				body: "Thanks! Accounts that already have uppercase addresses will need a one-off fix too.",
			},
			{ by: "sam", body: "Good catch. The same pull request now migrates them." },
		],
	},
	{
		team: "ENG",
		title: "Crash when pasting an image into the description",
		labels: ["bug"],
		status: "todo",
		priority: 1,
		assignee: "sam",
		by: "diego",
		description: "Paste a screenshot into an issue description: the editor goes blank.",
	},
	{
		team: "ENG",
		title: "Search issues by title from the command palette",
		labels: ["feature"],
		status: "in_progress",
		priority: 2,
		assignee: "maya",
		by: "maya",
	},
	{
		team: "ENG",
		title: "Slow first load on large workspaces",
		project: "reliability",
		labels: ["performance"],
		status: "in_progress",
		priority: 2,
		assignee: "lena",
		by: "sam",
		description:
			"A workspace with 20,000 issues takes about four seconds to open without a cache. " +
			"Profile the snapshot path and stream it if needed.",
		comments: [
			{
				by: "lena",
				body: "Profiled it: most of the time goes to building the snapshot in one piece. Sending it in pages gets the first screen up in under a second.",
			},
			{ by: "sam", body: "Nice. Does the local cache still work with paged snapshots?" },
		],
	},
	{
		team: "ENG",
		title: "Flaky test: realtime sync drops the last edit",
		project: "reliability",
		labels: ["bug"],
		status: "in_review",
		priority: 2,
		assignee: "lena",
		by: "lena",
		comments: [
			{
				by: "lena",
				body: "It only fails when the socket closes before the acknowledgement arrives. The fix is up for review.",
			},
		],
	},
	{
		team: "ENG",
		title: "Rate limit the sign-up endpoint",
		project: "reliability",
		labels: ["security"],
		status: "todo",
		priority: 2,
		assignee: null,
		by: "sam",
	},
	{
		team: "ENG",
		title: "Audit log for admin actions",
		labels: ["feature", "security"],
		status: "backlog",
		priority: 2,
		assignee: null,
		by: "maya",
	},
	{
		team: "ENG",
		title: "Paginate the activity feed",
		status: "todo",
		priority: 3,
		assignee: "diego",
		by: "sam",
	},
	{
		team: "ENG",
		title: "Webhooks for issue changes",
		labels: ["feature"],
		status: "backlog",
		priority: 3,
		assignee: null,
		by: "maya",
	},
	{
		team: "ENG",
		title: "Move background jobs to Queues",
		status: "backlog",
		priority: 3,
		assignee: null,
		by: "sam",
	},
	{
		team: "ENG",
		title: "Keyboard shortcut to copy the issue link",
		status: "in_review",
		priority: 4,
		assignee: "diego",
		by: "diego",
	},
	{
		team: "ENG",
		title: "Export issues as CSV",
		labels: ["feature"],
		status: "backlog",
		priority: 4,
		assignee: null,
		by: "lena",
	},
	{
		team: "ENG",
		title: "Upgrade to TypeScript 7",
		status: "done",
		priority: 3,
		assignee: "sam",
		by: "sam",
	},
	{
		team: "ENG",
		title: "Set up error tracking for the Worker",
		project: "reliability",
		status: "done",
		priority: 3,
		assignee: "sam",
		by: "maya",
	},
	{
		team: "ENG",
		title: "Disabled buttons are hard to read in dark mode",
		labels: ["bug", "accessibility"],
		status: "done",
		priority: 4,
		assignee: "diego",
		by: "lena",
	},
	{
		team: "ENG",
		title: "Remove the legacy v1 API",
		status: "canceled",
		priority: 0,
		assignee: null,
		by: "sam",
		description: "Nobody uses it any more, and it was never public.",
	},
	{
		team: "DES",
		title: "Mobile layout for the issue page",
		project: "polish",
		labels: ["improvement"],
		status: "in_review",
		priority: 2,
		assignee: "diego",
		by: "maya",
	},
	{
		team: "DES",
		title: "Empty states for lists and boards",
		project: "polish",
		status: "in_progress",
		priority: 3,
		assignee: "diego",
		by: "diego",
	},
	{
		team: "DES",
		title: "Onboarding checklist for new workspaces",
		status: "todo",
		priority: 2,
		assignee: "diego",
		by: "maya",
		description:
			"Three steps: create a team, invite someone, create the first issue. It disappears " +
			"once all three are done.",
	},
	{
		team: "DES",
		title: "Accessible focus rings across the app",
		project: "polish",
		labels: ["accessibility"],
		status: "todo",
		priority: 2,
		assignee: "maya",
		by: "lena",
	},
	{
		team: "DES",
		title: "Settings navigation feels hidden",
		project: "polish",
		status: "todo",
		priority: 3,
		assignee: null,
		by: "sam",
	},
	{
		team: "DES",
		title: "Refresh the marketing site hero",
		project: "launch",
		status: "backlog",
		priority: 3,
		assignee: null,
		by: "maya",
	},
	{
		team: "DES",
		title: "Illustrations for the 404 page",
		status: "backlog",
		priority: 4,
		assignee: null,
		by: "diego",
	},
	{
		team: "DES",
		title: "Icon set for issue priorities",
		project: "polish",
		status: "done",
		priority: 4,
		assignee: "diego",
		by: "diego",
	},
	{
		team: "DES",
		title: "Design tokens for spacing and radius",
		project: "polish",
		status: "done",
		priority: 3,
		assignee: "diego",
		by: "diego",
	},
	{
		team: "DES",
		title: "Explore a compact density mode",
		status: "canceled",
		priority: 0,
		assignee: null,
		by: "lena",
	},
	{
		team: "GRO",
		title: "Launch post for Show HN",
		project: "launch",
		status: "todo",
		priority: 1,
		assignee: "maya",
		by: "maya",
		description:
			"Lead with the architecture: one Durable Object per workspace, a local replica and " +
			"instant edits. Link the self-hosting guide and the demo workspace.",
		comments: [
			{ by: "sam", body: "The draft reads well. I would move the self-hosting link up top." },
			{
				by: "diego",
				body: "I can record a short clip of two tabs editing the same issue for the post.",
			},
		],
	},
	{
		team: "GRO",
		title: "Pricing page draft",
		project: "launch",
		status: "in_progress",
		priority: 2,
		assignee: "maya",
		by: "maya",
	},
	{
		team: "GRO",
		title: "Customer interviews: five teams moving off spreadsheets",
		status: "in_progress",
		priority: 3,
		assignee: "maya",
		by: "maya",
	},
	{
		team: "GRO",
		title: "Self-hosting guide",
		project: "launch",
		labels: ["docs"],
		status: "todo",
		priority: 2,
		assignee: "sam",
		by: "maya",
	},
	{
		team: "GRO",
		title: "Demo workspace that resets every night",
		project: "launch",
		status: "todo",
		priority: 2,
		assignee: "lena",
		by: "sam",
	},
	{
		team: "GRO",
		title: "Changelog page",
		project: "launch",
		labels: ["docs"],
		status: "backlog",
		priority: 3,
		assignee: null,
		by: "diego",
	},
	{
		team: "GRO",
		title: "Referral credits for invited workspaces",
		status: "backlog",
		priority: 4,
		assignee: null,
		by: "maya",
	},
	{
		team: "GRO",
		title: "Weekly product metrics email",
		status: "backlog",
		priority: 4,
		assignee: null,
		by: "sam",
	},
];

const VERBS = ["Fix", "Improve", "Refactor", "Document", "Test", "Speed up", "Clean up", "Review"];
const AREAS = [
	"the issue list",
	"the board view",
	"sign-in",
	"invitations",
	"the command palette",
	"team settings",
	"offline sync",
	"the issue page",
	"keyboard navigation",
	"the sync gateway",
];

/** Deterministic filler issues for load testing, spread over every team, state and person. */
export function generatedIssues(count: number): SampleIssue[] {
	const teams = Object.keys(TEAMS) as TeamKey[];
	const people = Object.keys(PEOPLE) as PersonKey[];
	const statuses: IssueStatus[] = [
		"backlog",
		"todo",
		"in_progress",
		"in_review",
		"done",
		"canceled",
	];
	return Array.from({ length: count }, (_, i) => ({
		team: pick(teams, i),
		title: `${pick(VERBS, i)} ${pick(AREAS, Math.floor(i / VERBS.length))} (${i + 1})`,
		status: pick(statuses, Math.floor(i / 3)),
		priority: pick([0, 1, 2, 3, 4] as const, Math.floor(i / 5)),
		assignee: i % 4 === 0 ? null : pick(people, Math.floor(i / 2)),
		by: pick(people, i),
	}));
}

function pick<T>(items: readonly T[], i: number): T {
	const item = items[i % items.length];
	if (item === undefined) throw new Error("pick() needs a non-empty list");
	return item;
}
