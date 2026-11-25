import { z } from "zod";
import { githubRepository, RUN_STATES, RUN_WAIT_REASONS } from "./sources";
import { userText } from "./text";

const issue = z
	.string()
	.max(64)
	.regex(/^[A-Z][A-Z0-9]*-[1-9]\d*$/);
// One spelling per id: a claim's nonce goes into its token's HMAC and is compared exactly.
const id = z.uuid().toLowerCase();
const attemptId = id;
const REPORT_URL_MAX = 1024;
/**
 * Who may claim a registered work request. The registration names one, and a claim from another
 * is refused, so work registered for a cloud run never quietly runs on the local host.
 */
export const WORK_RUN_EXECUTORS = ["local-runner", "cloud"] as const;
export type WorkRunExecutor = (typeof WORK_RUN_EXECUTORS)[number];
const executor = z.enum(WORK_RUN_EXECUTORS).default("local-runner");
export const workRunToken = z.string().regex(/^gwh_[A-Za-z0-9_-]{43}$/);
export const workRunTokenHash = z.string().regex(/^[a-f0-9]{64}$/);

export const registerWorkRunInput = z.strictObject({
	issue,
	repository: githubRepository,
	sourceId: z.string().min(1).max(64),
	executor,
});

export const findWorkRunInput = z.strictObject({ issue });

export const reconcileWorkRunInput = z.strictObject({
	attemptId,
	state: z.enum(["passed", "failed", "cancelled"]),
});

export const claimWorkRunInput = z.strictObject({
	requestId: id,
	claimId: id,
	previousAttemptId: attemptId.optional(),
	executor,
});

export const reportWorkRunInput = z.strictObject({
	attemptId,
	sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	state: z.enum(RUN_STATES),
	progress: userText.max(200).optional(),
	waitReason: z.enum(RUN_WAIT_REASONS).optional(),
	waitDetail: userText.max(200).optional(),
	url: z
		.string()
		.max(REPORT_URL_MAX)
		.pipe(z.url({ protocol: /^https?$/, normalize: true }))
		.refine((link) => !/^https?:\/\/[^/]*@/.test(link), "Use a URL without credentials")
		// The object parses the normalized link again, so the limit holds for that form too.
		.refine((link) => link.length <= REPORT_URL_MAX, "Use a shorter URL")
		.optional(),
});

export type RegisterWorkRunInput = z.infer<typeof registerWorkRunInput>;
export type ClaimWorkRunInput = z.infer<typeof claimWorkRunInput>;
export type ReconcileWorkRunInput = z.infer<typeof reconcileWorkRunInput>;
export type ReportWorkRunInput = z.infer<typeof reportWorkRunInput>;
