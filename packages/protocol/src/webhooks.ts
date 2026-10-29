import { z } from "zod";
import type { Comment, Issue, Proposal } from "./domain";

/**
 * Webhooks tell other services, such as an agent's trigger, about changes as they happen. Each
 * delivery is a POST signed per the Standard Webhooks spec (https://www.standardwebhooks.com):
 * `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, with a `whsec_` secret.
 */
export const WEBHOOK_EVENTS = [
	"issue.created",
	"issue.updated",
	"issue.deleted",
	"comment.created",
	"comment.updated",
	"comment.deleted",
	"proposal.created",
	"proposal.updated",
	"proposal.accepted",
	"proposal.dismissed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Sent only when an admin asks for a test delivery, whatever the webhook subscribes to. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

export const MAX_WEBHOOKS_PER_WORKSPACE = 10;

/** A workspace's subscription to its events. Its secret is shown once, when it is made. */
export interface Webhook {
	id: string;
	url: string;
	events: WebhookEventType[];
	/** Only this team's issues and their comments, or every team's when null. */
	teamId: string | null;
	/** The agent member this webhook sets off. Its own changes are not sent, so it cannot loop. */
	agentId: string | null;
	/** A paused webhook queues nothing and drops what it had not delivered. */
	active: boolean;
	/** The secret's first characters, to tell secrets apart. */
	secretStart: string;
	createdAt: number;
	updatedAt: number;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

/** One event on its way to one webhook. Its id is the `webhook-id` header, the same on retries. */
export interface WebhookDelivery {
	id: string;
	webhookId: string;
	event: WebhookEventType | typeof WEBHOOK_TEST_EVENT;
	status: WebhookDeliveryStatus;
	attempts: number;
	/** The last attempt's response status, or null if it got none (a network error or timeout). */
	responseStatus: number | null;
	error: string | null;
	/** When the next attempt is due, while the delivery is pending. */
	nextAttemptAt: number | null;
	createdAt: number;
	updatedAt: number;
}

const webhookUrl = z
	.url({ protocol: /^https?$/, error: "Enter an http or https URL" })
	.max(2048, "The URL is too long");

const webhookEvents = z
	.array(z.enum(WEBHOOK_EVENTS))
	.min(1, "Choose at least one event")
	.transform((events) => WEBHOOK_EVENTS.filter((event) => events.includes(event)));

const optionalId = z.string().min(1).max(64).nullable();

export const webhookInput = z.object({
	url: webhookUrl,
	events: webhookEvents,
	teamId: optionalId,
	agentId: optionalId,
});
export type WebhookInput = z.input<typeof webhookInput>;

export const webhookPatch = webhookInput.partial().extend({ active: z.boolean().optional() });
export type WebhookPatch = z.input<typeof webhookPatch>;

// Payloads. Every body is `{ type, timestamp, data }`, as Standard Webhooks recommends.

/** Who made a change. Agents are members that act for an AI agent, over MCP with a key. */
export interface WebhookActor {
	id: string;
	name: string;
	type: "person" | "agent";
}

export interface WebhookIssue extends Issue {
	/** The team key and number, such as `ENG-42`. */
	key: string;
	/** Where people open the issue. */
	url: string;
}

export interface WebhookWorkspace {
	id: string;
	/** The first segment of app URLs, which MCP tools take as `workspace`. */
	slug: string;
}

export interface WebhookProposal extends Proposal {
	/** The key of the proposal's issue, such as `ENG-42`. */
	issueKey: string;
}

interface Change {
	workspace: WebhookWorkspace;
	/** The workspace version after the change. A later change has a higher version. */
	version: number;
	actor: WebhookActor;
	issue: WebhookIssue;
}

interface Envelope<Type extends string, Data> {
	type: Type;
	/** When the change happened, as an ISO 8601 date. */
	timestamp: string;
	data: Data;
}

export type WebhookPayload =
	| Envelope<"issue.created" | "issue.deleted", Change>
	| Envelope<
			"issue.updated",
			Change & {
				/** The changed fields' values before the change. */
				updatedFrom: Partial<Issue>;
			}
	  >
	| Envelope<
			"comment.created" | "comment.updated" | "comment.deleted",
			Change & { comment: Comment }
	  >
	| Envelope<"proposal.created" | "proposal.updated", Change & { proposal: WebhookProposal }>
	| Envelope<
			"proposal.accepted" | "proposal.dismissed",
			Change & {
				proposal: WebhookProposal;
				/** Who decided: a person, or the agent itself when it withdrew the proposal. */
				decidedBy: WebhookActor;
				/** When it was decided, in milliseconds since the epoch. */
				decidedAt: number;
			}
	  >
	| Envelope<typeof WEBHOOK_TEST_EVENT, { workspace: WebhookWorkspace; webhookId: string }>;
