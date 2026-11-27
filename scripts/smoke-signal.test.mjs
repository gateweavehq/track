import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSmokeEvent, postSmokeSignal } from "./smoke-signal.mjs";

const now = new Date("2026-03-20T12:00:00.000Z");
const runUrl = "https://github.com/gateweavehq/track/actions/runs/42";
const input = { environment: "staging", runUrl, now };
const key = "gws_testkey123";
const env = {
	TRACK_CI_EVENTS_KEY: key,
	SMOKE_ENVIRONMENT: input.environment,
	SMOKE_OUTCOME: "failure",
	RUN_URL: runUrl,
};

test("a failed smoke test opens an alert", () => {
	const { body, ...event } = buildSmokeEvent({ ...input, outcome: "failure" });
	assert.deepEqual(event, {
		key: "smoke:staging",
		kind: "alert",
		state: "open",
		severity: "high",
		sentAt: "2026-03-20T12:00:00.000Z",
		title: "Smoke test failed on staging",
		url: runUrl,
	});
	assert.equal(typeof body, "string");
	assert.ok(body.trim());
});

test("a passed smoke test clears the same alert", () => {
	const event = buildSmokeEvent({ ...input, outcome: "success" });
	assert.equal(event.key, "smoke:staging");
	assert.equal(event.state, "cleared");
	assert.equal(event.severity, "high");
	assert.equal(event.title, "Smoke test passed on staging");
});

test("only failure and success build events", () => {
	for (const outcome of ["skipped", "cancelled", "", undefined]) {
		assert.equal(buildSmokeEvent({ ...input, outcome }), null, String(outcome));
		assert.equal(buildSmokeEvent({ outcome }), null, String(outcome));
	}
});

test("an event requires an environment and run URL", () => {
	for (const field of ["environment", "runUrl"]) {
		for (const value of [undefined, "", "  "]) {
			assert.throws(() => buildSmokeEvent({ ...input, outcome: "failure", [field]: value }));
		}
	}
});

test("both outcomes satisfy the smoke alert contract", () => {
	for (const outcome of ["failure", "success"]) {
		const event = buildSmokeEvent({ ...input, outcome });
		assert.deepEqual(Object.keys(event).sort(), [
			"body",
			"key",
			"kind",
			"sentAt",
			"severity",
			"state",
			"title",
			"url",
		]);
		assert.match(event.sentAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		assert.equal(event.severity, "high");
	}
});

test("an empty, whitespace-only, or missing events key skips without fetching", async () => {
	const { TRACK_CI_EVENTS_KEY: _key, ...withoutKey } = env;
	const calls = [];
	const fetchImpl = async (...args) => {
		calls.push(args);
		return new Response(null, { status: 204 });
	};
	for (const testEnv of [
		{ ...env, TRACK_CI_EVENTS_KEY: "" },
		{ ...env, TRACK_CI_EVENTS_KEY: " \t" },
		withoutKey,
	]) {
		const status = await postSmokeSignal({ env: testEnv, fetchImpl, now });
		assert.equal(calls.length, 0);
		assert.equal(status, "skipped: no events key");
	}
});

test("a skipped smoke test skips without fetching", async () => {
	const fetchImpl = test.mock.fn();
	const status = await postSmokeSignal({
		env: { ...env, SMOKE_OUTCOME: "skipped" },
		fetchImpl,
		now,
	});
	assert.equal(fetchImpl.mock.callCount(), 0);
	assert.equal(status, "skipped: no result");
});

test("posts the alert JSON with the bearer key, a timeout signal, and redirects disabled", async () => {
	const fetchImpl = test.mock.fn(async () => new Response(null, { status: 204 }));
	await postSmokeSignal({ env, fetchImpl, now });
	assert.equal(fetchImpl.mock.callCount(), 1);
	const [url, options] = fetchImpl.mock.calls[0].arguments;
	assert.equal(url, "https://track.gateweave.com/api/events");
	assert.equal(options.method, "POST");
	assert.equal(options.headers.authorization, `Bearer ${key}`);
	assert.equal(options.headers["content-type"], "application/json");
	assert.equal(options.redirect, "error");
	assert.ok(options.signal instanceof AbortSignal);
	assert.deepEqual(JSON.parse(options.body), buildSmokeEvent({ ...input, outcome: "failure" }));
});

test("an events URL override is used", async () => {
	const TRACK_EVENTS_URL = "https://track.example.test/api/events";
	const fetchImpl = test.mock.fn(async () => new Response(null, { status: 204 }));
	await postSmokeSignal({ env: { ...env, TRACK_EVENTS_URL }, fetchImpl, now });
	assert.equal(fetchImpl.mock.callCount(), 1);
	assert.equal(fetchImpl.mock.calls[0].arguments[0], TRACK_EVENTS_URL);
});

for (const url of [
	"http://track.example.test/api/events",
	"ftp://track.example.test/api/events",
	"track.example.test/api/events",
	"//track.example.test/api/events",
]) {
	test(`a non-https events URL makes no request and keeps the key private: ${url}`, async () => {
		const fetchImpl = test.mock.fn(async () => new Response(null, { status: 204 }));
		const actual = await postSmokeSignal({
			env: { ...env, TRACK_EVENTS_URL: url },
			fetchImpl,
			now,
		});
		assert.equal(fetchImpl.mock.callCount(), 0);
		assert.equal(actual, "Track smoke signal failed: the events URL must use https");
		assert.doesNotMatch(actual, /gws_testkey123/);
	});
}

test("a blank events URL override falls back to the default endpoint", async () => {
	const fetchImpl = test.mock.fn(async () => new Response(null, { status: 204 }));
	await postSmokeSignal({ env: { ...env, TRACK_EVENTS_URL: "  " }, fetchImpl, now });
	assert.equal(fetchImpl.mock.calls[0].arguments[0], "https://track.gateweave.com/api/events");
});

test("every reporting step in the deploy workflow continues on error", () => {
	const workflow = readFileSync(
		fileURLToPath(new URL("../.github/workflows/deploy.yml", import.meta.url)),
		"utf8",
	);
	const steps = workflow
		.split("      - name: ")
		.filter((step) => step.includes("scripts/smoke-signal.mjs"));
	assert.equal(steps.length, 3);
	for (const step of steps) {
		assert.match(step, /^Report the smoke result to Track/);
		assert.match(step, /^\s+continue-on-error: true$/m);
	}
});

const responses = [
	{
		name: "a 2xx response",
		fetchImpl: async () => new Response(null, { status: 204 }),
		status: "posted open for smoke:staging",
	},
	{
		name: "a 500 response that echoes the key",
		fetchImpl: async (_url, { headers }) => new Response(headers.authorization, { status: 500 }),
		status: "Track smoke signal failed: HTTP 500",
		warning: true,
	},
	{
		name: "a thrown error with the key in its message",
		fetchImpl: async (_url, { headers }) => {
			throw new TypeError(`Echoed ${headers.authorization}`);
		},
		status: "Track smoke signal failed: TypeError",
		warning: true,
	},
];

for (const { name, fetchImpl, status, warning } of responses) {
	test(`the returned status keeps the key private on ${name}`, async () => {
		const actual = await postSmokeSignal({ env, fetchImpl, now });
		assert.doesNotMatch(actual, /gws_testkey123/);
		assert.equal(actual, status);
	});
	test(`the CLI exits zero and keeps the key private on ${name}`, () => {
		const preload = `globalThis.fetch = ${fetchImpl.toString()};`;
		const script = fileURLToPath(new URL("smoke-signal.mjs", import.meta.url));
		const result = spawnSync(
			process.execPath,
			["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script],
			{ env, encoding: "utf8" },
		);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, "");
		assert.doesNotMatch(result.stdout, /gws_testkey123/);
		assert.equal(result.stdout.trimEnd(), warning ? `::warning::${status}` : status);
	});
}

test("the CLI skips quietly, with no warning, when there is no events key", () => {
	const script = fileURLToPath(new URL("smoke-signal.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script], {
		env: { ...env, TRACK_CI_EVENTS_KEY: "" },
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trimEnd(), "skipped: no events key");
});
