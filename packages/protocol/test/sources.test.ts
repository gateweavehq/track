import { expect, it } from "vitest";
import { ENTITY_NAMES, PROTOCOL_VERSION, sourceEventSchema, sourceSettingsSchema } from "../src";

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

it("R51: protocol 29 adds run signals to the sources' signals", () => {
	expect(PROTOCOL_VERSION).toBe(29);
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
