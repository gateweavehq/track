import { env } from "cloudflare:workers";
import { createHash, createHmac } from "node:crypto";
import {
	claimWorkRunInput,
	findWorkRunInput,
	isAdminRole,
	reconcileWorkRunInput,
	registerWorkRunInput,
	reportWorkRunInput,
	workRunToken,
} from "@gateweave/track-protocol";
import { z } from "zod";
import { db, getAuth } from "./auth";
import { findAgentByKey } from "./auth/agents";
import { readText } from "./body";
import { demoEnabled } from "./demo/mode";
import { findMembership, findMembershipById, workspaceStub } from "./workspaces";

const route = /^\/api\/work-runs\/(register|find|claim|report|reconcile)$/;
const scope = { workspace: z.string().min(1).max(100) };
const registration = registerWorkRunInput.extend(scope);
const reconciliation = reconcileWorkRunInput.extend(scope);
const report = reportWorkRunInput.extend({ token: workRunToken });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function isWorkRunRequest(url: URL): boolean {
	return route.test(url.pathname);
}

function answer(result: { status: number } & ({ error: string } | { value: unknown })) {
	return Response.json("error" in result ? { error: result.error } : result.value, {
		status: result.status,
		headers: {
			"cache-control": "no-store",
			...(result.status === 503 && { "retry-after": "60" }),
		},
	});
}

function error(status: number, message: string) {
	return answer({ status, error: message });
}

export async function handleWorkRunRequest(request: Request): Promise<Response> {
	if (demoEnabled()) return error(404, "Not found");
	if (request.method !== "POST") return error(405, "Method not allowed");
	const url = new URL(request.url);
	const action = route.exec(url.pathname)?.[1];
	const raw = await readText(request, 4096, true);
	let body: unknown;
	try {
		body = raw === null ? undefined : JSON.parse(raw);
	} catch {
		return error(400, "Invalid request");
	}

	if (action === "register" || action === "reconcile") {
		if (request.headers.get("origin") !== url.origin) return error(403, "Cross-origin request");
		const session = await getAuth().api.getSession({ headers: request.headers });
		if (!session) return error(401, "Not signed in");
		const parsed = (action === "register" ? registration : reconciliation).safeParse(body);
		if (!parsed.success) return error(400, "Invalid request");
		const { workspace, ...input } = parsed.data;
		const member = await findMembership(db, workspace, session.user.id);
		if (!member) return error(404, "Not found");
		if (!isAdminRole(member.profile.role))
			return error(403, "Only workspace admins can manage work");
		const stub = workspaceStub(member);
		const result =
			action === "register"
				? await stub.registerWorkRun(member.profile.id, input)
				: await stub.reconcileWorkRun(member.profile.id, input);
		return answer(result);
	}

	// The runner uses its agent key, never a browser session or an events source key.
	const key = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
	const agent = key && (await findAgentByKey(db, key));
	if (!agent) return error(401, "Invalid agent key");
	const member = await findMembershipById(db, agent.workspaceId, agent.userId);
	if (member?.profile.role !== "agent") return error(404, "Not found");
	const stub = workspaceStub(member);
	if (action === "find") {
		const input = findWorkRunInput.safeParse(body);
		if (!input.success) return error(400, "Invalid lookup");
		return answer(await stub.findWorkRun(agent.userId, input.data));
	}
	if (action === "claim") {
		const input = claimWorkRunInput.safeParse(body);
		if (!input.success) return error(400, "Invalid claim");
		const { requestId, claimId, previousAttemptId } = input.data;
		// A retried claim can recover the same token without storing the token in Track.
		const mac = createHmac("sha256", env.BETTER_AUTH_SECRET)
			.update(
				JSON.stringify([
					"track-work-run",
					agent.workspaceId,
					agent.userId,
					requestId,
					claimId,
					previousAttemptId ?? null,
				]),
			)
			.digest("base64url");
		const token = `gwh_${mac}`;
		const claimed = await stub.claimWorkRun(agent.userId, input.data, hash(token));
		return "value" in claimed
			? answer({ ...claimed, value: { ...claimed.value, token } })
			: answer(claimed);
	}
	const parsed = report.safeParse(body);
	if (!parsed.success) return error(400, "Invalid report");
	const { token, ...input } = parsed.data;
	return answer(await stub.reportWorkRun(agent.userId, input, hash(token)));
}
