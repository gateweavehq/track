import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import manifest from "../package.json" with { type: "json" };

// `vite build --mode <env>` takes the Wrangler environment from apps/web/.env.<env>. Without that
// file the build silently targets the top-level Worker, which is Gateweave's production, and the
// `wrangler deploy` that follows would replace it.
const web = fileURLToPath(new URL("..", import.meta.url));
const config = fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url));

const builds = Object.entries(manifest.scripts).flatMap(([script, command]) => {
	const mode = /vite build --mode (\S+)/.exec(command)?.[1];
	return mode ? [{ script, mode }] : [];
});

describe("environment builds", () => {
	it("covers staging and the demo", () => {
		expect(builds.map(({ mode }) => mode)).toEqual(expect.arrayContaining(["staging", "demo"]));
	});

	it.each(builds)("$script builds the $mode Worker, not production", ({ mode }) => {
		expect(loadEnv(mode, web, "CLOUDFLARE_ENV").CLOUDFLARE_ENV).toBe(mode);

		const production = unstable_readConfig({ config }, { hideWarnings: true });
		const environment = unstable_readConfig({ config, env: mode }, { hideWarnings: true });
		expect(environment.name).not.toBe(production.name);
		const database = ({ d1_databases }: typeof production): string | undefined =>
			d1_databases.find((d1: { binding: string }) => d1.binding === "DB")?.database_name;
		expect(database(environment)).toBeDefined();
		expect(database(environment)).not.toBe(database(production));
	});

	// Gateweave Cloud's production deploys the `cloud` environment (.github/workflows/deploy.yml).
	// Durable Objects belong to a Worker, so a different name would leave every workspace behind.
	it("deploys Cloud's production as the top-level Worker, with the same Durable Objects", () => {
		const production = unstable_readConfig({ config }, { hideWarnings: true });
		const cloud = unstable_readConfig({ config, env: "cloud" }, { hideWarnings: true });
		expect(cloud.name).toBe(production.name);
		expect(cloud.durable_objects.bindings).toEqual(production.durable_objects.bindings);
		const bindings = ({ d1_databases, r2_buckets }: typeof production) => [
			...d1_databases.map((d1: { binding: string }) => d1.binding),
			...r2_buckets.map((r2: { binding: string }) => r2.binding),
		];
		expect(bindings(cloud)).toEqual(bindings(production));
	});

	// "Where a workspace lives" in docs/architecture.md. Self-hosters' installs, the top level,
	// choose for themselves.
	it.each(["cloud", "staging", "demo"])("keeps %s's workspaces in the EU", (env) => {
		const environment = unstable_readConfig({ config, env }, { hideWarnings: true });
		expect(environment.vars.DURABLE_OBJECT_JURISDICTION).toBe("eu");
	});
});
