import { describe, expect, it } from "vitest";
import { FLAGS, flagValue } from "#/lib/flags";
import { evaluateFlags, type FlagStore } from "./evaluate";

/** A store that answers from a table, and remembers what it was asked. */
function storeOf(answers: Record<string, boolean | Error>) {
	const asked: { key: string; fallback: boolean; context: unknown }[] = [];
	const store: FlagStore = {
		async getBooleanValue(key, fallback, context) {
			asked.push({ key, fallback, context });
			const answer = answers[key];
			if (answer instanceof Error) throw answer;
			return answer ?? fallback;
		},
	};
	return { store, asked };
}

describe("evaluateFlags", () => {
	it("asks nothing and says nothing without a flag store", async () => {
		expect(await evaluateFlags(undefined, "workspace-1")).toBeUndefined();
	});

	it("leaves out a flag the store gives its default", async () => {
		const { store } = storeOf({ "my-issues-count": FLAGS["my-issues-count"] });
		expect(await evaluateFlags(store, "workspace-1")).toBeUndefined();
	});

	it("carries a flag the store turned on", async () => {
		const { store } = storeOf({ "my-issues-count": true });
		const values = await evaluateFlags(store, "workspace-1");
		expect(values).toEqual({ "my-issues-count": true });
		expect(flagValue(values, "my-issues-count")).toBe(true);
	});

	it("serves the default when the store fails", async () => {
		const { store } = storeOf({ "my-issues-count": new Error("store is down") });
		const values = await evaluateFlags(store, "workspace-1");
		expect(values).toBeUndefined();
		expect(flagValue(values, "my-issues-count")).toBe(FLAGS["my-issues-count"]);
	});

	it("asks for every listed flag with its default, by the workspace's id only", async () => {
		const { store, asked } = storeOf({});
		await evaluateFlags(store, "workspace-1");
		expect(asked.map(({ key }) => key).sort()).toEqual(Object.keys(FLAGS).sort());
		for (const { key, fallback, context } of asked) {
			expect(fallback).toBe(FLAGS[key as keyof typeof FLAGS]);
			expect(context).toEqual({ targetingKey: "workspace-1", workspace: "workspace-1" });
		}
	});
});

describe("flagValue", () => {
	it("is the default for a workspace that carries no flags", () => {
		expect(flagValue(undefined, "my-issues-count")).toBe(false);
		expect(flagValue({}, "my-issues-count")).toBe(false);
	});

	it("ignores what a device remembered in another shape", () => {
		const remembered = { "my-issues-count": "yes" } as unknown as Parameters<typeof flagValue>[0];
		expect(flagValue(remembered, "my-issues-count")).toBe(false);
	});
});
