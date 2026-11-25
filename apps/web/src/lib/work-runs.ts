import {
	RUN_STATES,
	registerWorkRunInput,
	WORK_RUN_EXECUTORS,
	type WorkRunExecutor,
} from "@gateweave/track-protocol";
import { z } from "zod";

/** An assignment's approval for a runner: where its work goes and how its last attempt ended. */
const approvalSchema = z.object({
	requestId: z.string(),
	repository: z.string(),
	executor: z.enum(WORK_RUN_EXECUTORS),
	sourceId: z.string(),
	activeAttemptId: z.string().nullable(),
	lastAttemptId: z.string().nullable(),
	lastAttemptState: z.enum(RUN_STATES).nullable(),
});
export type WorkRunApproval = z.infer<typeof approvalSchema>;

export const WORK_RUN_EXECUTOR_LABELS: Record<WorkRunExecutor, string> = {
	"local-runner": "Local runner",
	cloud: "Cloud",
};

export type ApprovalAnswer =
	| { ok: true; approval: WorkRunApproval | null }
	| { ok: false; message: string };

const FAILED = "Track could not answer. Try again.";

/** Posts from this page, so the gateway sees Track's own origin and the session. */
async function post(action: "approval" | "register", body: object): Promise<Response> {
	return fetch(`/api/work-runs/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function refusal(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === "string" ? body.error : FAILED;
}

/** The issue's current approval, or null when its assignment has none. */
export async function readApproval(workspace: string, issue: string): Promise<ApprovalAnswer> {
	try {
		const response = await post("approval", { workspace, issue });
		if (response.status === 404) return { ok: true, approval: null };
		if (!response.ok) return { ok: false, message: await refusal(response) };
		const parsed = approvalSchema.safeParse(await response.json());
		return parsed.success ? { ok: true, approval: parsed.data } : { ok: false, message: FAILED };
	} catch {
		return { ok: false, message: FAILED };
	}
}

export interface ApprovalForm {
	repository: string;
	sourceId: string;
	executor: WorkRunExecutor;
}

/**
 * Approves the issue's current assignment for a runner. The same approval again answers with the
 * one already made; a different one is refused with the server's reason.
 */
export async function approveWorkRun(
	workspace: string,
	issue: string,
	form: ApprovalForm,
): Promise<ApprovalAnswer> {
	try {
		const response = await post("register", { workspace, issue, ...form });
		if (!response.ok) return { ok: false, message: await refusal(response) };
		const parsed = approvalSchema.omit({ sourceId: true }).safeParse(await response.json());
		return parsed.success
			? { ok: true, approval: { ...parsed.data, sourceId: form.sourceId } }
			: { ok: false, message: FAILED };
	} catch {
		return { ok: false, message: FAILED };
	}
}

/** The repository as the server keeps it, or null when it is not a GitHub `owner/repo`. */
export function normalizeRepository(value: string): string | null {
	const parsed = registerWorkRunInput.shape.repository.safeParse(value);
	return parsed.success ? parsed.data : null;
}
