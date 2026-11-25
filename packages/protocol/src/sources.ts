import { z } from "zod";
import { userText } from "./text";

// U1 measures the largest webhook delivery for this request size.
export const EVENT_MAX_BYTES = 16 * 1024;
export const RESTORE_SIGNALS = 2_000;
export const RESTORE_SIGNAL_BYTES = 8 * 1024 * 1024;
// Space for replicated signal fields within an unpaged workspace snapshot.
export const WORKSPACE_RESTORE_SIGNAL_BYTES = 8 * 1024 * 1024;
export const MAX_REOPENS = 1_000_000;
// U1 measures the payload with 4,000 characters of body text.
export const EVENT_BODY_MAX = 4_000;
// Allow sender clocks to lead the object by up to five minutes.
export const EVENT_CLOCK_SKEW_MS = 5 * 60_000;
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
// Runs are shorter-lived than alerts: a finished one leaves the replica after 30 days.
export const RUN_KEPT_DAYS = 30;
// Unfinished runs one source holds at once.
export const LIVE_RUNS = 200;
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
export const SIGNAL_KINDS = ["alert", "run"] as const;
/** A run's lifecycle: queued work, then how it ended. */
export const RUN_STATES = ["queued", "running", "passed", "failed", "cancelled"] as const;
/** The run states that still hold a live slot; the rest are finished. */
export const UNFINISHED_RUN_STATES = ["queued", "running"] as const;
/** Every state a signals row can hold: an alert's, or a run's. */
export const SIGNAL_STORED_STATES = [...SIGNAL_STATES, ...RUN_STATES] as const;
/** Who executes a run, as the issue row names it. */
export const RUN_EXECUTORS = ["agents-hosted", "local-runner", "cloud"] as const;
/** Why a queued or waiting run waits, structured so the issue row can say what unblocks it. */
export const RUN_WAIT_REASONS = [
	"waiting-for-slot",
	"runner-offline",
	"needs-mapping",
	"budget-limit",
	"retry",
] as const;
export type SourceProduct = (typeof SOURCE_PRODUCTS)[number];
export type SourceThreshold = (typeof SOURCE_THRESHOLDS)[number];
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];
export type SignalState = (typeof SIGNAL_STATES)[number];
export type SignalKind = (typeof SIGNAL_KINDS)[number];
export type RunState = (typeof RUN_STATES)[number];
export type RunExecutor = (typeof RUN_EXECUTORS)[number];
export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

/**
 * A GitHub repository as `owner/name`, in one spelling: a work run's registration names one, and
 * the attempts it hands out carry it to their run signals.
 */
export const githubRepository = z
	.string()
	.trim()
	.toLowerCase()
	.max(200)
	.regex(/^[a-z0-9-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/);

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

// UTF-8 length. A lone surrogate counts three bytes, as the U+FFFD that encoding writes for it.
function utf8Bytes(text: string) {
	let bytes = 0;
	for (const char of text) {
		const code = char.charCodeAt(0);
		bytes += char.length === 2 ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
	}
	return bytes;
}

function jsonBytes(value: unknown) {
	return utf8Bytes(JSON.stringify(value));
}

const settingsFields = {
	name: userText
		.trim()
		.min(1)
		.max(64)
		.regex(/^[^\r\n]+$/),
	product: z.enum(SOURCE_PRODUCTS),
	teamId: userText.min(1).max(64),
	lowestSeverity: z.enum(SOURCE_THRESHOLDS),
	closeWhenCleared: z.boolean(),
};
export const sourceUpdateSchema = z.strictObject(settingsFields).partial();
export const sourceSettingsSchema = z.strictObject({
	...settingsFields,
	lowestSeverity: settingsFields.lowestSeverity.default("high"),
	closeWhenCleared: settingsFields.closeWhenCleared.default(false),
	linkOrigins: z.array(origin),
});
export type SourceSettings = z.infer<typeof sourceSettingsSchema>;

const eventTime = z.iso.datetime({ offset: true }).refine((date) => !/\.\d{4}/.test(date));
// A stored timestamp is a nonnegative epoch millisecond, so a run clock set before 1970 is
// refused here rather than failing every export that carries the row.
const storedEventTime = eventTime.refine((date) => Date.parse(date) >= 0);

const eventFields = {
	key: userText.min(1),
	kind: z.enum(SIGNAL_KINDS).default("alert"),
	state: z.enum(SIGNAL_STORED_STATES),
	// Signal ordering uses epoch milliseconds, as do Track's other timestamps.
	sentAt: eventTime,
	// Required for an alert, refused for a run: enforced below.
	severity: z.enum(SIGNAL_SEVERITIES).optional(),
	// Ordinary issues, including an import of this one, accept up to 512 characters.
	title: z.string().transform(plainSourceTitle).pipe(userText.min(1).max(512)),
	type: userText.min(1).optional(),
	subject: userText.min(1).optional(),
	body: userText.max(EVENT_BODY_MAX).optional(),
	url: link.optional(),
	// A run may name the issue it works on, by key such as `ENG-12`; it never files one.
	issue: userText.min(1).max(64).optional(),
	progress: userText.max(200).optional(),
	startedAt: storedEventTime.optional(),
	endedAt: storedEventTime.optional(),
	executor: z.enum(RUN_EXECUTORS).optional(),
	agent: userText.max(64).optional(),
	waitReason: z.enum(RUN_WAIT_REASONS).optional(),
	waitDetail: userText.max(200).optional(),
};

/** Fields only a run carries; an alert that sends one is refused. */
const RUN_ONLY_FIELDS = [
	"issue",
	"progress",
	"startedAt",
	"endedAt",
	"executor",
	"agent",
	"waitReason",
	"waitDetail",
] as const;

export const sourceEventSchema = z.strictObject(eventFields).superRefine((event, ctx) => {
	if (event.kind === "alert") {
		if (event.severity === undefined)
			ctx.addIssue({
				code: "custom",
				message: "An alert needs a severity",
				path: ["severity"],
			});
		for (const field of RUN_ONLY_FIELDS)
			if (event[field] !== undefined)
				ctx.addIssue({
					code: "custom",
					message: `An alert has no ${field}`,
					path: [field],
				});
		if (!(SIGNAL_STATES as readonly string[]).includes(event.state))
			ctx.addIssue({
				code: "custom",
				message: "An alert's state is open, cleared or dismissed",
				path: ["state"],
			});
		return;
	}
	if (event.severity !== undefined)
		ctx.addIssue({ code: "custom", message: "A run has no severity", path: ["severity"] });
	if (event.body !== undefined)
		ctx.addIssue({ code: "custom", message: "A run has no body", path: ["body"] });
	if (!(RUN_STATES as readonly string[]).includes(event.state))
		ctx.addIssue({
			code: "custom",
			message: "A run's state is queued, running, passed, failed or cancelled",
			path: ["state"],
		});
});
export type SourceEvent = z.infer<typeof sourceEventSchema>;

const reference = userText.min(1).max(64);
export const exportedSourceSchema = z.object({
	...sourceSettingsSchema.shape,
	lowestSeverity: settingsFields.lowestSeverity,
	closeWhenCleared: settingsFields.closeWhenCleared,
	id: reference,
	assigneeId: reference.nullable(),
});
export const exportedSignalSchema = z.object({
	sourceId: reference,
	// Files written before runs existed carry no kind; they are alerts.
	kind: z.enum(SIGNAL_KINDS).default("alert"),
	key: sourceEventSchema.shape.key,
	type: sourceEventSchema.shape.type.unwrap().nullable(),
	subject: sourceEventSchema.shape.subject.unwrap().nullable(),
	severity: sourceEventSchema.shape.severity.unwrap(),
	state: sourceEventSchema.shape.state,
	url: link.nullable(),
	issueId: reference.nullable(),
	reopens: z.int().min(0).max(MAX_REOPENS),
	firstAt: z.int().nonnegative(),
	changedAt: z.int().nonnegative(),
	progress: userText.max(200).nullish(),
	startedAt: z.int().nonnegative().nullish(),
	endedAt: z.int().nonnegative().nullish(),
	executor: z.enum(RUN_EXECUTORS).nullish(),
	agentName: userText.max(64).nullish(),
	waitReason: z.enum(RUN_WAIT_REASONS).nullish(),
	waitDetail: userText.max(200).nullish(),
	lastContactAt: z.int().nonnegative().nullish(),
	// Files written before attempts were numbered carry none. No upper bound: the claim counts on
	// without one, and a refused signal would stop the whole export.
	attemptNo: z.int().positive().nullish(),
	// Files written before attempts carried their repository have none.
	repository: githubRepository.nullish(),
});
// Include the array separator and reserve room for the gateway's two derived import ids.
export function restoreSignalBytes(signal: z.infer<typeof exportedSignalSchema>) {
	const derivedIdLength = "import-".length + 32;
	return (
		jsonBytes(signal) +
		1 +
		Math.max(0, derivedIdLength - signal.sourceId.length) +
		(signal.issueId === null ? 0 : Math.max(0, derivedIdLength - signal.issueId.length))
	);
}

export function fitsRestoreOrigins(origins: string[]) {
	return jsonBytes(origins) <= 16 * 1024;
}

export function fitsEventBudget(size: number) {
	return size <= EVENT_MAX_BYTES;
}

// A URL's normal form writes each UTF-8 byte of its path, query or fragment as at most three
// bytes (`%E7`), and a punycode host stays within that. An event's URL is under 16 KiB.
export const STORED_EVENT_URL_MAX_BYTES = 3 * EVENT_MAX_BYTES;

// A restored signal is never larger than one the event path can store, and its key can be
// reached by an event. Track stores key, type, subject, severity and state as sent, and
// JSON.stringify is their shortest encoding, so the smallest event carrying them is exact: the
// shortest title and sending time, and no URL. Track stores the URL in its normal form, which an
// event need not repeat (the next event's URL replaces it), so it is held to the stored bound.
export const restoredSignalSchema = exportedSignalSchema
	.extend({
		url: exportedSignalSchema.shape.url.refine(
			(url) => url === null || utf8Bytes(url) <= STORED_EVENT_URL_MAX_BYTES,
			"Signal URL exceeds what an event can store",
		),
	})
	.refine(
		(row) =>
			fitsEventBudget(
				jsonBytes({
					key: row.key,
					title: "x",
					severity: row.severity,
					state: row.state,
					type: row.type ?? undefined,
					subject: row.subject ?? undefined,
					sentAt: "2000-01-01T00:00:00Z",
				}),
			),
		"Signal exceeds the event size limit",
	)
	.superRefine((row, ctx) => {
		// An old file's rows are alerts; a run's state never passes for one, or the reverse.
		const states: readonly string[] = row.kind === "run" ? RUN_STATES : SIGNAL_STATES;
		if (!states.includes(row.state))
			ctx.addIssue({
				code: "custom",
				message:
					row.kind === "run"
						? "A run's state is queued, running, passed, failed or cancelled"
						: "An alert's state is open, cleared or dismissed",
				path: ["state"],
			});
		// Only a scoped attempt has a number.
		if (row.kind === "alert" && row.attemptNo != null)
			ctx.addIssue({
				code: "custom",
				message: "An alert has no attempt number",
				path: ["attemptNo"],
			});
		if (row.kind === "alert" && row.repository != null)
			ctx.addIssue({
				code: "custom",
				message: "An alert has no repository",
				path: ["repository"],
			});
	});

export const RESTORE_ISSUE_MISSING =
	"An issue for this source is not saved yet. Import the same file again to restore it.";

export const sourceRestoreSchema = z.object({
	// Sender order restarts after this, so an event sent before the export stays old.
	exportedAt: z.iso.datetime({ offset: true }),
	source: exportedSourceSchema.refine(
		(source) => fitsRestoreOrigins(source.linkOrigins),
		"Link origins exceed 16 KiB",
	),
	signals: z
		.array(restoredSignalSchema)
		.max(RESTORE_SIGNALS)
		.refine(
			(rows) =>
				rows.reduce((bytes, row) => bytes + restoreSignalBytes(row), 2) <= RESTORE_SIGNAL_BYTES,
			"Signals exceed the restore byte limit",
		),
});
export type SourceRestore = z.infer<typeof sourceRestoreSchema>;
export interface RestoreCounts {
	restored: number;
	present: number;
	bound: number;
	dropped: number;
	otherTeam: number;
	alreadyLinked: number;
	overLimit: number;
}

export interface Source extends SourceSettings {
	id: string;
	assigneeId: string | null;
	paused: boolean;
	lastHeardAt: number | null;
}

export interface Signal {
	id: string;
	sourceId: string;
	kind: SignalKind;
	key: string;
	type: string | null;
	subject: string | null;
	severity: SignalSeverity;
	state: SignalState | RunState;
	url: string | null;
	issueId: string | null;
	reopens: number;
	firstAt: number;
	changedAt: number;
	/** A run's short progress line; null for alerts and runs that report none. */
	progress: string | null;
	startedAt: number | null;
	endedAt: number | null;
	executor: RunExecutor | null;
	agentName: string | null;
	waitReason: RunWaitReason | null;
	waitDetail: string | null;
	/** When the server last accepted an event for the signal. */
	lastContactAt: number | null;
	/**
	 * A scoped runner attempt's number within its registration, from 1, so the Runs card can
	 * name it. Null for alerts and for runs a product reports, whose key is their name.
	 */
	attemptNo: number | null;
	/**
	 * The repository a scoped attempt works in, `owner/name`, from its registration, which a
	 * report cannot change. Null for alerts and for runs a product reports.
	 */
	repository: string | null;
}

function plainSourceTitle(title: string) {
	return title
		.replace(/[\r\n\u2028\u2029]+/gu, " ")
		.replace(/[\p{Cc}\u200b]/gu, "")
		.trim();
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

export function sourceLimitNotice(name: string, limit: string) {
	return {
		title: plainSourceTitle(`${name} reached ${limit}`),
		description: `Track refused an event from ${escapeSourceText(name)} because it reached ${limit}.`,
	};
}

export function sourceReopenComment(name: string) {
	return escapeSourceText(name) + " reported this signal open again.";
}

export function sourceIssueText(event: SourceEvent, source: Pick<Source, "name">) {
	const attribution = `Reported by ${escapeSourceText(source.name)}, a connected product, not a member`;
	// A longer fence than any in the body also keeps our mention scanner inside the block.
	const body = event.body ?? "";
	const longest = Array.from(body.matchAll(/~+/g), (match) => match[0].length);
	const fence = "~".repeat(Math.max(2, ...longest) + 1);
	return {
		title: event.title,
		description: body ? `${attribution}\n\n${fence}\n${body}\n${fence}` : attribution,
	};
}
