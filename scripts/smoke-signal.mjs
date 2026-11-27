// The deploy workflow reports post-deploy smoke results to Track as one alert per environment.

import { pathToFileURL } from "node:url";

export function buildSmokeEvent({ environment, outcome, runUrl, now }) {
	if (outcome !== "failure" && outcome !== "success") return null;
	if (!environment?.trim()) throw new Error("A smoke environment is required");
	if (!runUrl?.trim()) throw new Error("A workflow run URL is required");

	const failed = outcome === "failure";
	return {
		key: `smoke:${environment}`,
		kind: "alert",
		state: failed ? "open" : "cleared",
		severity: "high",
		sentAt: now.toISOString(),
		title: `Smoke test ${failed ? "failed" : "passed"} on ${environment}`,
		body: failed
			? "The post-deploy smoke test failed, and the link opens the workflow run."
			: "The post-deploy smoke test passed.",
		url: runUrl,
	};
}

const DEFAULT_EVENTS_URL = "https://track.gateweave.com/api/events";

function isHttps(value) {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

export async function postSmokeSignal({ env, fetchImpl = fetch, now = new Date() }) {
	const key = env.TRACK_CI_EVENTS_KEY?.trim();
	if (!key) return "skipped: no events key";

	try {
		const event = buildSmokeEvent({
			environment: env.SMOKE_ENVIRONMENT,
			outcome: env.SMOKE_OUTCOME,
			runUrl: env.RUN_URL,
			now,
		});
		if (!event) return "skipped: no result";

		// The override lets a self-hosted copy report to its own Track. The key only ever travels over https.
		const url = env.TRACK_EVENTS_URL?.trim() || DEFAULT_EVENTS_URL;
		if (!isHttps(url)) return "Track smoke signal failed: the events URL must use https";

		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(event),
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return `Track smoke signal failed: HTTP ${response.status}`;
		return `posted ${event.state} for ${event.key.replaceAll(key, "[redacted]")}`;
	} catch (error) {
		const name = error instanceof Error ? error.name : "Error";
		const safeName = /^[a-zA-Z][a-zA-Z0-9]*$/.test(name) && !name.includes(key) ? name : "Error";
		return `Track smoke signal failed: ${safeName}`;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const status = await postSmokeSignal({ env: process.env });
	// Only a failed report is a warning: a skip is the normal state until the key exists.
	console.log(status.includes("failed") ? `::warning::${status}` : status);
}
