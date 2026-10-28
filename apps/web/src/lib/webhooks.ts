import {
	type RejectReason,
	type Webhook,
	type WebhookDelivery,
	webhookInput,
	webhookPatch,
} from "@gateweave/track-protocol";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

export type { Webhook, WebhookDelivery } from "@gateweave/track-protocol";

/** An action's outcome, as the workspace's Durable Object decided it. */
export type WebhookOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; reason: RejectReason; message: string };

export interface WorkspaceWebhooks {
	admin: boolean;
	/** False where this server sends no webhooks, as on the public demo. */
	enabled: boolean;
	webhooks: Webhook[];
	deliveries: WebhookDelivery[];
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
	message: "This server sends no webhooks",
};

async function access(workspace: string) {
	const { webhookAccess, webhooksEnabled } = await import("#/server/webhooks");
	return { access: await webhookAccess(workspace, getRequest()), enabled: webhooksEnabled() };
}

/** The workspace's webhooks and their latest deliveries, for admins. Null for non-members. */
export const getWorkspaceWebhooks = createServerFn({ method: "GET" })
	.validator(slug)
	.handler(async ({ data: workspace }): Promise<WorkspaceWebhooks | null> => {
		const { access: found, enabled } = await access(workspace);
		if (!found) return null;
		if (!found.admin) return { admin: false, enabled, webhooks: [], deliveries: [] };
		const result = await found.stub.webhooks(found.member);
		return result.ok
			? { admin: true, enabled, ...result.value }
			: { admin: false, enabled, webhooks: [], deliveries: [] };
	});

export const createWebhook = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, input: webhookInput }))
	.handler(async ({ data }): Promise<WebhookOutcome<{ webhook: Webhook; secret: string }>> => {
		const { access: found, enabled } = await access(data.workspace);
		if (!found) return notMember;
		if (!enabled) return disabled;
		return found.stub.createWebhook(found.member, found.link, data.input);
	});

export const updateWebhook = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id, patch: webhookPatch }))
	.handler(async ({ data }): Promise<WebhookOutcome<Webhook>> => {
		const { access: found, enabled } = await access(data.workspace);
		if (!found) return notMember;
		if (!enabled) return disabled;
		return found.stub.updateWebhook(found.member, found.link, data.id, data.patch);
	});

export const deleteWebhook = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id }))
	.handler(async ({ data }): Promise<WebhookOutcome<null>> => {
		const { access: found } = await access(data.workspace);
		if (!found) return notMember;
		return found.stub.deleteWebhook(found.member, data.id);
	});

export const rotateWebhookSecret = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id }))
	.handler(async ({ data }): Promise<WebhookOutcome<string>> => {
		const { access: found, enabled } = await access(data.workspace);
		if (!found) return notMember;
		if (!enabled) return disabled;
		return found.stub.rotateWebhookSecret(found.member, data.id);
	});

export const testWebhook = createServerFn({ method: "POST" })
	.validator(z.object({ workspace: slug, id }))
	.handler(async ({ data }): Promise<WebhookOutcome<null>> => {
		const { access: found, enabled } = await access(data.workspace);
		if (!found) return notMember;
		if (!enabled) return disabled;
		return found.stub.testWebhook(found.member, found.link, data.id);
	});
