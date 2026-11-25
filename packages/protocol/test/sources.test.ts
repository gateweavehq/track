import { expect, it } from "vitest";
import {
	ENTITY_NAMES,
	exportedSignalSchema,
	PROTOCOL_VERSION,
	restoredSignalSchema,
	sourceEventSchema,
	sourceSettingsSchema,
} from "../src";

it("R7: source events require the finite state and severity lists and a millisecond-orderable timestamp", () => {
	const valid = {
		key: "incident",
		title: "Queue is full",
		state: "open",
		severity: "high",
		sentAt: "2026-10-30T10:00:00Z",
	};
	expect(sourceEventSchema.parse(valid)).toEqual({ ...valid, kind: "alert" });
	for (const change of [
		{ key: "" },
		{ title: "" },
		{ title: "\0" },
		{ severity: "warn" },
		{ state: "running" },
		{ sentAt: 12 },
		{ sentAt: "2026-02-30T12:00:00Z" },
		{ sentAt: "2026-10-30T10:00:00.00001Z" },
		{ body: "x".repeat(4001) },
		{ kind: "run" },
		{ url: "javascript:alert(1)" },
	]) {
		expect(sourceEventSchema.safeParse({ ...valid, ...change }).success).toBe(false);
	}
});

it("R11: a source accepts only whole HTTP link origins and normalizes their host and port", () => {
	const form = {
		name: "Guard",
		product: "guard",
		teamId: "eng",
		linkOrigins: ["https://Reports.Example:443/"],
	};
	expect(sourceSettingsSchema.parse(form).linkOrigins).toEqual(["https://reports.example"]);
	expect(
		sourceSettingsSchema.safeParse({
			...form,
			linkOrigins: Array(1000).fill("https://reports.example"),
		}).success,
	).toBe(true);
	for (const origin of [
		"https://reports.example/path",
		"https://reports.example/?q=x",
		"https://user@reports.example",
		"file:///reports",
		"https://reports.example/#fragment",
	]) {
		expect(sourceSettingsSchema.safeParse({ ...form, linkOrigins: [origin] }).success).toBe(false);
	}
});

it("R51: protocol 29 added run signals to the sources' signals, and 30 numbers scoped attempts", () => {
	expect(PROTOCOL_VERSION).toBe(30);
	expect(ENTITY_NAMES).toContain("source");
	expect(ENTITY_NAMES).toContain("signal");
});

it("run events carry the run's lifecycle and details, and refuse what only alerts have", () => {
	const run = {
		key: "fix-eng-12",
		kind: "run",
		state: "running",
		title: "Fix ENG-12",
		sentAt: "2026-10-30T10:00:00Z",
		issue: "ENG-12",
		progress: "3 of 5 checks",
		executor: "local-runner",
		agent: "Codex",
		waitReason: "waiting-for-slot",
	};
	const parsed = sourceEventSchema.parse(run);
	expect(parsed.kind).toBe("run");
	expect(parsed.severity).toBeUndefined();
	for (const change of [
		{ state: "open" },
		{ state: "cleared" },
		{ severity: "high" },
		{ body: "notes" },
		{ executor: "laptop" },
		{ waitReason: "bored" },
	]) {
		expect(sourceEventSchema.safeParse({ ...run, ...change }).success).toBe(false);
	}
	// An alert keeps its own contract: severity required, run fields refused.
	const alert = {
		key: "incident",
		state: "open",
		severity: "high",
		title: "Queue is full",
		sentAt: "2026-10-30T10:00:00Z",
	};
	expect(sourceEventSchema.safeParse({ ...alert, progress: "3 of 5" }).success).toBe(false);
	expect(
		sourceEventSchema.safeParse({
			key: alert.key,
			state: alert.state,
			title: alert.title,
			sentAt: alert.sentAt,
		}).success,
	).toBe(false);
});

it("run timestamps must survive export, and a restored signal's state must fit its kind", () => {
	const run = {
		key: "fix-eng-12",
		kind: "run",
		state: "running",
		title: "Fix ENG-12",
		sentAt: "2026-10-30T10:00:00Z",
	};
	for (const change of [
		{ startedAt: "1969-12-31T23:59:59.999Z" },
		{ endedAt: "1969-12-31T23:59:59.999Z" },
	]) {
		expect(sourceEventSchema.safeParse({ ...run, ...change }).success).toBe(false);
	}
	for (const change of [
		{ startedAt: "2026-10-30T09:00:00Z" },
		{ startedAt: "2026-10-30T09:00:00+02:00" },
	]) {
		expect(sourceEventSchema.safeParse({ ...run, ...change }).success).toBe(true);
	}
	const row = {
		sourceId: "source",
		key: "build",
		type: null,
		subject: null,
		severity: "unknown",
		url: null,
		issueId: null,
		reopens: 0,
		firstAt: 1,
		changedAt: 1,
	};
	// A row with no kind is an alert: a run state on one is refused, and the reverse too.
	expect(
		restoredSignalSchema.safeParse({
			...row,
			kind: "alert",
			state: "running",
			title: "x",
		}).success,
	).toBe(false);
	expect(
		restoredSignalSchema.safeParse({
			...row,
			kind: "run",
			state: "open",
			title: "x",
		}).success,
	).toBe(false);
	expect(exportedSignalSchema.safeParse({ ...row, kind: "run", state: "passed" }).success).toBe(
		true,
	);
	expect(exportedSignalSchema.safeParse({ ...row, kind: "alert", state: "open" }).success).toBe(
		true,
	);
	// WEB-86: an attempt's number travels with the file; older files carry none.
	const attempt = { ...row, kind: "run", state: "passed" };
	expect(exportedSignalSchema.parse({ ...attempt, attemptNo: 2 }).attemptNo).toBe(2);
	expect(exportedSignalSchema.parse(attempt).attemptNo).toBeUndefined();
	for (const attemptNo of [0, 1.5, -1, "2"]) {
		expect(exportedSignalSchema.safeParse({ ...attempt, attemptNo }).success).toBe(false);
	}
	expect(
		restoredSignalSchema.safeParse({
			...row,
			kind: "run",
			state: "passed",
			title: "x",
		}).success,
	).toBe(true);
	expect(
		restoredSignalSchema.safeParse({ ...row, kind: "alert", state: "open", title: "x" }).success,
	).toBe(true);
});
