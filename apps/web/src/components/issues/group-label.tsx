import { MemberAvatar } from "#/components/members/member-avatar";
import { ProjectStatusIcon } from "#/components/projects/meta";
import type { IssueGroup } from "#/lib/grouping";
import { useMembersById, useProjectsById } from "#/lib/queries";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon } from "./meta";

/** The name of a group, as text. */
export function useGroupName(): (group: IssueGroup) => string {
	const members = useMembersById();
	const projects = useProjectsById();
	return (group) => {
		switch (group.by) {
			case "status":
				return STATUS_META[group.value].label;
			case "priority":
				return PRIORITY_META[group.value].label;
			case "assignee":
				return group.value === null ? "Unassigned" : (members.get(group.value)?.name ?? "Unknown");
			case "project":
				return group.value === null ? "No project" : (projects.get(group.value)?.name ?? "Unknown");
			case "none":
				return "All issues";
		}
	};
}

/** A group's icon: what the issues in it have in common. */
export function GroupIcon({ group }: { group: IssueGroup }) {
	const members = useMembersById();
	const projects = useProjectsById();
	switch (group.by) {
		case "status":
			return <StatusIcon status={group.value} />;
		case "priority":
			return <PriorityIcon priority={group.value} />;
		case "assignee":
			return <MemberAvatar member={group.value ? members.get(group.value) : undefined} />;
		case "project": {
			const project = group.value ? projects.get(group.value) : undefined;
			return project ? <ProjectStatusIcon status={project.status} /> : null;
		}
		case "none":
			return null;
	}
}
