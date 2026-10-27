import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, MAX_LABELS_PER_ISSUE } from "./domain";

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
			labelIds: z.array(id).max(MAX_LABELS_PER_ISSUE).default([]),
			sortOrder,
		}),
	}),
	z.object({
		name: z.literal("issue.update"),
		args: z.object({
			id,
			/** The issue `version` the client saw when it made the edit. */
			baseVersion: z.number().int().nonnegative(),
			patch: z
				.object({ title, description, status, priority, assigneeId: id.nullable(), sortOrder })
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
]);

export type Mutation = z.infer<typeof mutationSchema>;
/** Mutation as written by a client, before schema defaults are applied. */
export type MutationInput = z.input<typeof mutationSchema>;
export type MutationName = Mutation["name"];
export type MutationArgs<N extends MutationName> = Extract<Mutation, { name: N }>["args"];
