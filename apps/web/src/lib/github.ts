import type { GitHubConnection } from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { WebhookOutcome } from "./webhooks";

export type { GitHubConnection } from "@gateweave/track-protocol";

export interface WorkspaceGitHub {
	admin: boolean;
	/** False where this server takes no deliveries, as on the public demo. */
	enabled: boolean;
	/** Where the workspace's connections receive deliveries; each adds its id. */
	endpoint: string;
	connections: GitHubConnection[];
}

const slug = z.string().min(1);
const id = z.string().min(1).max(64);

const notMember: WebhookOutcome<never> = {
	ok: false,
	reason: "not_found",
	message: "You are no longer a member of this workspace",
};
const disabled: WebhookOutcome<never> = {
	ok: false,
	reason: "forbidden",
	message: "This server connects to no GitHub repositories",
};

// Connections live in the workspace's Durable Object, like webhooks, behind the same check.
async function access(workspace: string) {
	const { webhookAccess, webhooksEnabled } = await import("#/server/webhooks");
	return { access: await webhookAccess(workspace, getRequest()), enabled: webhooksEnabled() };
}

/** The workspace's GitHub connections, for admins. Null for non-members. */
export const getWorkspaceGitHub = createServerFn({ method: "GET" })
	.validator(slug)
	.handler(async ({ data: workspace }): Promise<WorkspaceGitHub | null> => {
		const { access: found, enabled } = await access(workspace);
		if (!found) return null;
		const endpoint = `${found.link.origin}/api/github/${found.link.id}`;
		const none = { admin: false, enabled, endpoint, connections: [] };
		if (!found.admin) return none;
		const result = await found.stub.githubConnections(found.member);
		return result.ok ? { admin: true, enabled, endpoint, connections: result.value } : none;
	});

export const createGitHubConnection = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug }))
	.handler(
		async ({ data }): Promise<WebhookOutcome<{ connection: GitHubConnection; secret: string }>> => {
			const { access: found, enabled } = await access(data.workspace);
			if (!found) return notMember;
			if (!enabled) return disabled;
			return found.stub.createGitHubConnection(found.member);
		},
	);

export const rotateGitHubSecret = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id }))
	.handler(async ({ data }): Promise<WebhookOutcome<string>> => {
		const { access: found, enabled } = await access(data.workspace);
		if (!found) return notMember;
		if (!enabled) return disabled;
		return found.stub.rotateGitHubSecret(found.member, data.id);
	});

export const deleteGitHubConnection = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id }))
	.handler(async ({ data }): Promise<WebhookOutcome<null>> => {
		const { access: found } = await access(data.workspace);
		if (!found) return notMember;
		return found.stub.deleteGitHubConnection(found.member, data.id);
	});
