import { z } from "zod";
import { userText } from "./text";

// U1 measures the largest webhook delivery for this request size.
export const EVENT_MAX_BYTES = 16 * 1024;
// U1 measures the payload with 4,000 characters of body text.
export const EVENT_BODY_MAX = 4_000;
// U2 measures Guard's largest scan.
export const CALLS_PER_MINUTE = 60;
// The connect endpoints already count bad calls per address over both windows.
export const BAD_KEYS_PER_ADDRESS = { hour: 20, day: 100 } as const;
// U2 measures how many issues one source needs to file.
export const ISSUES_PER_DAY = 30;
// U2 measures how many issues a workspace needs to take.
export const WORKSPACE_ISSUES_PER_DAY = 100;
// U3 measures the oplog and fan-out cost of a write.
export const WRITES_PER_DAY = 300;
// U3 measures the oplog and fan-out cost of stored text.
export const BYTES_PER_DAY = 2 * 1024 * 1024;
// Status's flapping incidents in production set this limit.
export const REOPENS_PER_KEY_PER_DAY = 3;
// Stay under Agents' 20 runs a day.
export const ASSIGNED_PER_DAY = 10;
// U2 measures the number of findings a source keeps open.
export const LIVE_SIGNALS = 500;
// No measurement fixes the number of sources yet.
export const SOURCES_PER_WORKSPACE = 20;
// No measurement fixes the number of concurrent keys yet.
export const KEYS_PER_SOURCE = 2;
// No measurement fixes the interval between last-heard updates yet (milliseconds).
export const LAST_HEARD_EVERY = 60 * 60 * 1000;
// No measurement fixes the retention period yet.
export const SIGNAL_KEPT_DAYS = 90;

export const SOURCE_PRODUCTS = ["guard", "status", "backup", "agents", "ci", "other"] as const;
export const SOURCE_THRESHOLDS = ["critical", "high", "medium", "low"] as const;
export const SIGNAL_SEVERITIES = [...SOURCE_THRESHOLDS, "unknown"] as const;
export const SIGNAL_STATES = ["open", "cleared", "dismissed"] as const;
export type SourceProduct = (typeof SOURCE_PRODUCTS)[number];
export type SourceThreshold = (typeof SOURCE_THRESHOLDS)[number];
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];
export type SignalState = (typeof SIGNAL_STATES)[number];

const link = userText
	.pipe(z.url({ protocol: /^https?$/, normalize: true }))
	.refine((value) => !/^https?:\/\/[^/]*@/.test(value), "Use a URL without credentials");

// The URL validator canonicalizes hosts, ports and schemes, and gives an origin a trailing slash.
const origin = link
	.refine(
		(value) => /^https?:\/\/[^/]+\/$/.test(value),
		"Enter an origin without a path, query or fragment",
	)
	.transform((value) => value.slice(0, -1));

export const sourceSettingsSchema = z.strictObject({
	name: userText
		.trim()
		.min(1)
		.max(64)
		.regex(/^[^\r\n]+$/),
	product: z.enum(SOURCE_PRODUCTS),
	teamId: userText.min(1).max(64),
	lowestSeverity: z.enum(SOURCE_THRESHOLDS).default("high"),
	closeWhenCleared: z.boolean().default(false),
	linkOrigins: z.array(origin),
});
export type SourceSettings = z.infer<typeof sourceSettingsSchema>;

export const sourceEventSchema = z.strictObject({
	key: userText.min(1),
	state: z.enum(SIGNAL_STATES),
	// Signal ordering uses epoch milliseconds, as do Track's other timestamps.
	sentAt: z.iso.datetime({ offset: true }).refine((date) => !/\.\d{4}/.test(date)),
	severity: z.enum(SIGNAL_SEVERITIES),
	// Ordinary issues, including an import of this one, accept up to 512 characters.
	title: userText
		.trim()
		.min(1)
		.max(512)
		.refine((title) => escapeSourceText(title).length <= 512, "The escaped title is too long"),
	type: userText.min(1).optional(),
	subject: userText.min(1).optional(),
	body: userText.max(EVENT_BODY_MAX).optional(),
	url: link.optional(),
});
export type SourceEvent = z.infer<typeof sourceEventSchema>;

export interface Source extends SourceSettings {
	id: string;
	assigneeId: string | null;
	paused: boolean;
	lastHeardAt: number | null;
}

export interface Signal {
	id: string;
	sourceId: string;
	key: string;
	type: string | null;
	subject: string | null;
	severity: SignalSeverity;
	state: SignalState;
	url: string | null;
	issueId: string | null;
	reopens: number;
	firstAt: number;
	changedAt: number;
}

export function escapeSourceText(text: string): string {
	// GitHub-flavored Markdown autolinks again after interpreting backslash escapes. Break its
	// three literal patterns before escaping the punctuation for links, images and mentions.
	return text
		.replace(/(https?)(?=:)/gi, "$1\u200b")
		.replace(/www(?=\.)/gi, "$&\u200b")
		.replaceAll("@", "@\u200b")
		.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/g, "\\$&")
		.replace(/[\r\n]+/g, " ");
}

export function sourceIssueText(event: SourceEvent, source: Pick<Source, "name">) {
	const title = escapeSourceText(event.title);
	const attribution = `Reported by ${escapeSourceText(source.name)}, a connected product, not a member`;
	// A longer fence than any in the body also keeps our mention scanner inside the block.
	const body = event.body ?? "";
	const longest = Array.from(body.matchAll(/~+/g), (match) => match[0].length);
	const fence = "~".repeat(Math.max(2, ...longest) + 1);
	return {
		title,
		description: body ? `${attribution}\n\n${fence}\n${body}\n${fence}` : attribution,
	};
}
