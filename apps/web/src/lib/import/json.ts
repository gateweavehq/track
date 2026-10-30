import {
	ISSUE_PRIORITIES,
	ISSUE_STATUSES,
	PROJECT_STATUSES,
	RELATION_TYPES,
} from "@gateweave/track-protocol";
import { z } from "zod";
import { EXPORT_FORMAT, EXPORT_VERSION } from "#/lib/export";
import type { ImportedComment, ImportedIssue, ImportSource } from "./plan";

// Track's own JSON export (`workspaceToJson`), read back: issues with their comments, relations,
// parents, labels and their colors, and projects and their details, so a workspace or a team moves
// between Track workspaces, such as from a self-hosted copy to Gateweave Cloud. History stays
// behind: activity belongs to the people who made it, and an import is the importer's.

const ref = z.string().min(1);
const nullableRef = ref.nullable().catch(null);

/** What the import reads of an export. Unknown fields are ignored; later versions may add some. */
const exportFile = z.object({
	workspace: z.object({ name: z.string() }).partial().optional(),
	teams: z.array(z.object({ id: ref, key: z.string(), name: z.string() })),
	members: z.array(z.object({ id: ref, name: z.string(), email: z.string() })),
	labels: z.array(z.object({ id: ref, name: z.string(), color: z.string() })),
	projects: z.array(
		z.object({
			id: ref,
			name: z.string(),
			description: z.string().nullable().catch(null),
			status: z.enum(PROJECT_STATUSES).catch("planned"),
			leadId: nullableRef,
			targetDate: z.string().nullable().catch(null),
		}),
	),
	issues: z.array(
		z.object({
			id: ref,
			teamId: ref,
			key: z.string().optional(),
			title: z.string(),
			description: z.string().nullable().catch(null),
			status: z.enum(ISSUE_STATUSES).catch("backlog"),
			priority: z.literal(ISSUE_PRIORITIES).catch(0),
			assigneeId: nullableRef,
			projectId: nullableRef,
			parentId: nullableRef,
			startDate: z.string().nullable().catch(null),
			dueDate: z.string().nullable().catch(null),
			estimate: z.number().nullable().catch(null),
			labelIds: z.array(z.string()).catch([]),
			createdAt: z.number().nullable().catch(null),
		}),
	),
	comments: z
		.array(
			z.object({
				id: ref,
				issueId: ref,
				authorId: z.string(),
				body: z.string(),
				createdAt: z.number().nullable().catch(null),
			}),
		)
		.catch([]),
	activities: z.array(z.unknown()).catch([]),
	// Exports made before relations existed have none.
	relations: z
		.array(
			z.object({
				id: ref,
				type: z.enum(RELATION_TYPES),
				issueId: ref,
				relatedIssueId: ref,
			}),
		)
		.catch([]),
});

const sourceId = (id: string) => `track:${id}`;

/** Reads an export. Throws, with a message for the person, when the file is not one. */
export function readJsonImport(text: string): { source: ImportSource; notes: string[] } {
	let data: unknown;
	try {
		data = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
	} catch {
		throw new Error("This file is not valid JSON.");
	}
	const header = z.object({ format: z.string(), version: z.number() }).safeParse(data);
	if (!header.success || header.data.format !== EXPORT_FORMAT) {
		throw new Error("This JSON file is not a Gateweave Track export.");
	}
	if (header.data.version > EXPORT_VERSION) {
		throw new Error("This export was made by a newer version of Track. Update this one first.");
	}
	const parsed = exportFile.safeParse(data);
	if (!parsed.success) {
		const where = parsed.error.issues[0]?.path.join(".") || "the file";
		throw new Error(`This export could not be read: ${where} is not as Track writes it.`);
	}
	const file = parsed.data;

	const teams = new Map(file.teams.map((team) => [team.id, team]));
	const members = new Map(file.members.map((member) => [member.id, member]));
	const labels = new Map(file.labels.map((label) => [label.id, label]));
	const projects = new Map(file.projects.map((project) => [project.id, project]));
	const issueIds = new Set(file.issues.map((issue) => issue.id));
	const person = (id: string | null) => {
		const member = id ? members.get(id) : undefined;
		return member ? { name: member.name, email: member.email } : null;
	};

	const comments = new Map<string, ImportedComment[]>();
	for (const comment of file.comments) {
		if (!issueIds.has(comment.issueId)) continue;
		const list = comments.get(comment.issueId) ?? [];
		list.push({
			sourceId: sourceId(comment.id),
			body: comment.body,
			author: members.get(comment.authorId)?.name ?? null,
			createdAt: comment.createdAt,
		});
		comments.set(comment.issueId, list);
	}

	const issues: ImportedIssue[] = file.issues.map((issue) => {
		const team = teams.get(issue.teamId);
		return {
			sourceId: sourceId(issue.id),
			title: issue.title,
			description: issue.description,
			status: issue.status,
			priority: issue.priority,
			labels: issue.labelIds.flatMap((id) => labels.get(id)?.name ?? []),
			assignee: person(issue.assigneeId),
			project: (issue.projectId && projects.get(issue.projectId)?.name) || null,
			parentSourceId:
				issue.parentId && issueIds.has(issue.parentId) ? sourceId(issue.parentId) : null,
			team: team ? { key: team.key, name: team.name } : null,
			startDate: issue.startDate,
			dueDate: issue.dueDate,
			estimate: issue.estimate,
			createdAt: issue.createdAt,
			url: null,
			reference: issue.key ?? null,
			comments: comments.get(issue.id) ?? [],
		};
	});

	const notes: string[] = [];
	if (file.activities.length > 0) {
		notes.push(
			"The issues' history stays behind: an import brings issues, comments and relations.",
		);
	}
	return {
		source: {
			name: file.workspace?.name?.trim() || "Track",
			issues,
			labelColors: new Map(file.labels.map((label) => [label.name, label.color])),
			projects: file.projects.map((project) => ({
				name: project.name,
				description: project.description,
				status: project.status,
				lead: person(project.leadId),
				targetDate: project.targetDate,
			})),
			relations: file.relations
				.filter(
					(relation) => issueIds.has(relation.issueId) && issueIds.has(relation.relatedIssueId),
				)
				.map((relation) => ({
					sourceId: sourceId(relation.id),
					type: relation.type,
					issueSourceId: sourceId(relation.issueId),
					relatedIssueSourceId: sourceId(relation.relatedIssueId),
				})),
		},
		notes,
	};
}
