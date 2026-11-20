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
	expect(sourceEventSchema.parse(valid)).toEqual(valid);
	for (const change of [
		{ key: "" },
		{ title: "" },
		{ title: "a\0b" },
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

it("R51: protocol 28 adds sources and signals to the replicated entities", () => {
	expect(PROTOCOL_VERSION).toBe(28);
	expect(ENTITY_NAMES).toContain("source");
	expect(ENTITY_NAMES).toContain("signal");
});
