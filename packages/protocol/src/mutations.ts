import { z } from "zod";
import {
	AGENT_CHANGE_KINDS,
	ISSUE_LAYOUTS,
	ISSUE_PRIORITIES,
	ISSUE_STATUSES,
	MAX_LABELS_PER_ISSUE,
	PROJECT_STATUSES,
	RELATION_TYPES,
} from "./domain";
import { issueFilters } from "./filters";

/** Client-generated ids. UUIDv7 is recommended so ids sort by creation time. */
const id = z.string().min(1).max(64);
const teamKey = z
	.string()
	.regex(/^[A-Z][A-Z0-9]{0,6}$/, "1-7 uppercase letters or digits, starting with a letter");
const teamName = z.string().trim().min(1).max(64);
const title = z.string().trim().min(1).max(512);
const description = z.string().max(100_000).nullable();
const status = z.enum(ISSUE_STATUSES);
const priority = z.literal(ISSUE_PRIORITIES);
const sortOrder = z.string().min(1).max(128);
const labelName = z.string().trim().min(1).max(64);
const labelColor = z.string().regex(/^#[0-9a-f]{6}$/, "A lowercase hex color, like #e5484d");
const projectName = z.string().trim().min(1).max(64);
const projectStatus = z.enum(PROJECT_STATUSES);
/** `YYYY-MM-DD`, and a day that exists: 2026-02-30 is refused. */
export const calendarDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-03-31")
	.refine((value) => {
		const date = new Date(`${value}T00:00:00Z`);
		return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
	}, "Not a real calendar date");
/** Points. Teams pick their own scale; 0 is a valid size, for work too small to count. */
export const estimate = z.number().int().min(0).max(1000);
const commentBody = z.string().trim().min(1).max(100_000);
/**
 * When an issue or comment was first written, in the tracker it is imported from (epoch ms).
 * Only admins may set it, and the server keeps it no later than its own clock.
 */
const importedCreatedAt = z
	.number()
	.int()
	.min(Date.UTC(2000, 0, 1))
	.optional();

const viewName = z.string().trim().min(1).max(80);
const nonEmpty = (patch: object) => Object.keys(patch).length > 0;

export const mutationSchema = z.discriminatedUnion("name", [
	z.object({
		name: z.literal("team.create"),
		args: z.object({ id, key: teamKey, name: teamName }),
	}),
	z.object({
		name: z.literal("team.update"),
		args: z.object({
			id,
			patch: z.object({ key: teamKey, name: teamName }).partial().refine(nonEmpty, "Empty patch"),
		}),
	}),
	z.object({
		name: z.literal("issue.create"),
		args: z.object({
			id,
			teamId: id,
			title,
			description: description.default(null),
			status: status.default("backlog"),
			priority: priority.default(0),
			assigneeId: id.nullable().default(null),
			projectId: id.nullable().default(null),
			parentId: id.nullable().default(null),
			startDate: calendarDate.nullable().default(null),
			dueDate: calendarDate.nullable().default(null),
			estimate: estimate.nullable().default(null),
			labelIds: z.array(id).max(MAX_LABELS_PER_ISSUE).default([]),
			sortOrder,
			createdAt: importedCreatedAt,
		}),
	}),
	z.object({
		name: z.literal("issue.update"),
		args: z.object({
			id,
			/** The issue `version` the client saw when it made the edit. */
			baseVersion: z.number().int().nonnegative(),
			patch: z
				.object({
					title,
					description,
					status,
					priority,
					assigneeId: id.nullable(),
					projectId: id.nullable(),
					parentId: id.nullable(),
					startDate: calendarDate.nullable(),
					dueDate: calendarDate.nullable(),
					estimate: estimate.nullable(),
					sortOrder,
				})
				.partial()
				.refine(nonEmpty, "Empty patch"),
		}),
	}),
	z.object({
		name: z.literal("issue.delete"),
		args: z.object({ id }),
	}),
	// Adding and removing labels are set operations rather than a patch of `labelIds`, so that
	// people labeling the same issue at the same time never conflict.
	z.object({
		name: z.literal("issue.addLabel"),
		args: z.object({ id, labelId: id }),
	}),
	z.object({
		name: z.literal("issue.removeLabel"),
		args: z.object({ id, labelId: id }),
	}),
	z.object({
		name: z.literal("label.create"),
		args: z.object({ id, name: labelName, color: labelColor }),
	}),
	z.object({
		name: z.literal("label.update"),
		args: z.object({
			id,
			patch: z
				.object({ name: labelName, color: labelColor })
				.partial()
				.refine(nonEmpty, "Empty patch"),
		}),
	}),
	z.object({
		name: z.literal("label.delete"),
		args: z.object({ id }),
	}),
	z.object({
		name: z.literal("project.create"),
		args: z.object({
			id,
			name: projectName,
			description: description.default(null),
			status: projectStatus.default("planned"),
			leadId: id.nullable().default(null),
			targetDate: calendarDate.nullable().default(null),
		}),
	}),
	z.object({
		name: z.literal("project.update"),
		args: z.object({
			id,
			patch: z
				.object({
					name: projectName,
					description,
					status: projectStatus,
					leadId: id.nullable(),
					targetDate: calendarDate.nullable(),
				})
				.partial()
				.refine(nonEmpty, "Empty patch"),
		}),
	}),
	z.object({
		name: z.literal("project.delete"),
		args: z.object({ id }),
	}),
	z.object({
		name: z.literal("comment.create"),
		args: z.object({ id, issueId: id, body: commentBody, createdAt: importedCreatedAt }),
	}),
	// Only the author edits a comment, so there is no one to conflict with: the last edit wins.
	z.object({
		name: z.literal("comment.update"),
		args: z.object({ id, body: commentBody }),
	}),
	z.object({
		name: z.literal("comment.delete"),
		args: z.object({ id }),
	}),
	// Any member relates issues, agents included, and nothing about it is proposed. A relation
	// between two issues that already have one replaces it.
	z.object({
		name: z.literal("relation.create"),
		args: z.object({
			id,
			type: z.enum(RELATION_TYPES),
			issueId: id,
			relatedIssueId: id,
		}),
	}),
	z.object({
		name: z.literal("relation.delete"),
		args: z.object({ id }),
	}),
	// Any member saves views. A personal one belongs to whoever makes it; a shared one can be
	// changed by its creator and by admins. `personal` in a patch moves a view between the two.
	z.object({
		name: z.literal("view.create"),
		args: z.object({
			id,
			name: viewName,
			personal: z.boolean().default(false),
			layout: z.enum(ISSUE_LAYOUTS),
			filters: issueFilters,
		}),
	}),
	z.object({
		name: z.literal("view.update"),
		args: z.object({
			id,
			patch: z
				.object({
					name: viewName,
					personal: z.boolean(),
					layout: z.enum(ISSUE_LAYOUTS),
					filters: issueFilters,
				})
				.partial()
				.refine(nonEmpty, "Empty patch"),
		}),
	}),
	z.object({
		name: z.literal("view.delete"),
		args: z.object({ id }),
	}),
	// Admins only. Agents themselves are made in settings, like people's memberships.
	z.object({
		name: z.literal("agent.update"),
		args: z.object({
			id,
			patch: z
				.object({ proposes: z.array(z.enum(AGENT_CHANGE_KINDS)).max(AGENT_CHANGE_KINDS.length) })
				.partial()
				.refine(nonEmpty, "Empty patch"),
		}),
	}),
	// People decide on agents' proposals; agents never do, their own included.
	z.object({
		name: z.literal("proposal.accept"),
		args: z.object({ id }),
	}),
	z.object({
		name: z.literal("proposal.dismiss"),
		args: z.object({ id }),
	}),
]);

export type Mutation = z.infer<typeof mutationSchema>;
/** Mutation as written by a client, before schema defaults are applied. */
export type MutationInput = z.input<typeof mutationSchema>;
export type MutationName = Mutation["name"];
export type MutationArgs<N extends MutationName> = Extract<Mutation, { name: N }>["args"];
