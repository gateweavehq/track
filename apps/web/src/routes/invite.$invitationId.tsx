import { deleteIdbReplicas } from "@gateweave/track-sync-client";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";
import { formatRelative } from "#/lib/dates";
import { previewInvitation } from "#/lib/members";
import { useDocumentTitle } from "#/lib/title";
import type { InvitationPreview } from "#/server/workspaces";

export const Route = createFileRoute("/invite/$invitationId")({
	loader: ({ params }) => previewInvitation({ data: params.invitationId }),
	component: InvitePage,
});

function InvitePage() {
	const { invitation, viewer } = Route.useLoaderData();
	const { invitationId } = Route.useParams();
	useDocumentTitle(invitation ? `Join ${invitation.workspaceName}` : "Invitation");

	if (!invitation) {
		return (
			<Card title="This invitation is no longer valid">
				<p className="text-sm text-muted-foreground">
					It may have expired, been revoked or already been used. Ask whoever invited you for a new
					link.
				</p>
				<Button asChild variant="outline" className="w-full">
					<Link to="/">Go to Gateweave Track</Link>
				</Button>
			</Card>
		);
	}
	return <ValidInvitation invitationId={invitationId} invitation={invitation} viewer={viewer} />;
}

function ValidInvitation({
	invitationId,
	invitation,
	viewer,
}: {
	invitationId: string;
	invitation: InvitationPreview;
	viewer: { email: string } | null;
}) {
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const here = `/invite/${invitationId}`;
	const title = `Join ${invitation.workspaceName}`;
	const role = invitation.role === "admin" ? "an admin" : `a ${invitation.role}`;
	const intro = (
		<p className="text-sm text-muted-foreground">
			{invitation.inviterName} invited <span className="text-foreground">{invitation.email}</span>{" "}
			to join as {role}. The invitation expires {formatRelative(invitation.expiresAt)}.
		</p>
	);

	async function switchAccount() {
		setPending(true);
		await authClient.signOut();
		// Replicas are cached per user; leave nothing behind for the next account.
		await deleteIdbReplicas().catch(() => {});
		await router.invalidate();
		await router.navigate({ to: "/login", search: { redirect: here, email: invitation.email } });
	}

	async function accept() {
		setPending(true);
		const result = await authClient.organization.acceptInvitation({ invitationId });
		if (result.error) {
			setPending(false);
			toast.error("Could not join", { description: result.error.message });
			return;
		}
		await router.navigate({ to: "/$workspace", params: { workspace: invitation.workspaceSlug } });
	}

	async function decline() {
		setPending(true);
		const result = await authClient.organization.rejectInvitation({ invitationId });
		setPending(false);
		if (result.error) {
			toast.error("Could not decline", { description: result.error.message });
			return;
		}
		toast.success("Invitation declined");
		await router.navigate({ to: "/" });
	}

	if (!viewer) {
		return (
			<Card title={title}>
				{intro}
				<div className="space-y-2">
					<Button asChild className="w-full">
						<Link to="/login" search={{ redirect: here, email: invitation.email, mode: "sign-up" }}>
							Create an account
						</Link>
					</Button>
					<Button asChild variant="outline" className="w-full">
						<Link to="/login" search={{ redirect: here, email: invitation.email }}>
							Sign in
						</Link>
					</Button>
				</div>
			</Card>
		);
	}

	if (viewer.email.toLowerCase() !== invitation.email.toLowerCase()) {
		return (
			<Card title={title}>
				{intro}
				<p className="text-sm">
					You are signed in as <span className="font-medium">{viewer.email}</span>. Sign in with{" "}
					{invitation.email} to accept.
				</p>
				<Button className="w-full" onClick={switchAccount} disabled={pending}>
					Switch account
				</Button>
			</Card>
		);
	}

	return (
		<Card title={title}>
			{intro}
			<div className="space-y-2">
				<Button className="w-full" onClick={accept} disabled={pending}>
					Join {invitation.workspaceName}
				</Button>
				<Button variant="ghost" className="w-full" onClick={decline} disabled={pending}>
					Decline
				</Button>
			</div>
		</Card>
	);
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{children}
			</div>
		</main>
	);
}
