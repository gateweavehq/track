import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { MembersSettings } from "#/components/settings/members-settings";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getWorkspaceMembers } from "#/lib/members";
import { useActiveMembers } from "#/lib/queries";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/members")({
	validateSearch: z.object({ invite: z.boolean().optional().catch(undefined) }),
	// Membership lives in D1, so this page reads it from there rather than from the replica.
	loader: ({ params }) => getWorkspaceMembers({ data: params.workspace }),
	component: MembersPage,
});

function MembersPage() {
	const data = Route.useLoaderData();
	const { invite } = Route.useSearch();
	useDocumentTitle("Members");
	useReloadOnMemberChange();

	if (!data) {
		return (
			<Notice title="Members unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return (
		<MembersSettings
			members={data.members}
			invitations={data.invitations}
			focusInvite={invite === true}
		/>
	);
}

/**
 * The list comes from D1, but the replica hears about joins, removals and role changes as they
 * happen. Reload when it does, so this page never disagrees with the rest of the app.
 */
function useReloadOnMemberChange() {
	const router = useRouter();
	const { userId } = useWorkspace();
	const members = useActiveMembers();
	const signature = members
		.map((member) => `${member.id}:${member.role}`)
		.sort()
		.join(",");
	// Without access the sync gate takes over, and reloading would only hit a 404.
	const stillMember = members.some((member) => member.id === userId);
	const loaded = useRef(signature);
	useEffect(() => {
		if (loaded.current === signature) return;
		loaded.current = signature;
		if (stillMember) void router.invalidate({ filter: (match) => match.routeId === Route.id });
	}, [router, signature, stillMember]);
}
