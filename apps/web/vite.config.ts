import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, transformWithOxc } from "vite";

/**
 * Settings Track runs without (see src/server/env.d.ts). `secrets.required` in wrangler.jsonc
 * stops a deploy that lacks BETTER_AUTH_SECRET, but in local dev it also drops every other key
 * from .dev.vars. So in dev, these are added to the list when .dev.vars sets them.
 */
const OPTIONAL_SECRETS = [
	"BETTER_AUTH_URL",
	"GITHUB_CLIENT_ID",
	"GITHUB_CLIENT_SECRET",
	"EMAIL_FROM",
	"TRACK_DEMO",
];

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		cloudflare({
			// At the repository root, for the "Deploy to Cloudflare" button (see wrangler.jsonc).
			configPath: "../../wrangler.jsonc",
			viteEnvironment: { name: "ssr" },
			// The end-to-end tests keep their data apart from `pnpm dev` (see e2e/server.mjs).
			persistState: process.env.TRACK_STATE_DIR ? { path: process.env.TRACK_STATE_DIR } : true,
			config: (config) => {
				if (command !== "serve") return;
				const set = devVarsKeys();
				const optional = OPTIONAL_SECRETS.filter((key) => set.has(key));
				return { secrets: { required: [...(config.secrets?.required ?? []), ...optional] } };
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		serviceWorker(),
		rootDeployConfig(),
	],
}));

/**
 * Wrangler finds the build output through .wrangler/deploy/config.json, which the Cloudflare
 * plugin writes next to this file. Workers Builds runs the commands people do not write, like
 * `npx wrangler preview` for a branch, from the repository root, so that needs a copy too.
 */
function rootDeployConfig(): Plugin {
	return {
		name: "track:root-deploy-config",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "ssr",
		writeBundle: {
			order: "post",
			sequential: true,
			handler() {
				const from = join(this.environment.config.root, ".wrangler", "deploy");
				const to = fileURLToPath(new URL("../../.wrangler/deploy", import.meta.url));
				const rebase = (path: string) => relative(to, resolve(from, path));
				const config = JSON.parse(readFileSync(join(from, "config.json"), "utf8"));
				config.configPath = rebase(config.configPath);
				if (config.prerenderWorkerConfigPath) {
					config.prerenderWorkerConfigPath = rebase(config.prerenderWorkerConfigPath);
				}
				config.auxiliaryWorkers = config.auxiliaryWorkers.map((worker: { configPath: string }) => ({
					configPath: rebase(worker.configPath),
				}));
				mkdirSync(to, { recursive: true });
				writeFileSync(join(to, "config.json"), JSON.stringify(config));
			},
		},
	};
}

/**
 * Builds service-worker/sw.ts into /sw.js, with the list of files it keeps so that Track can
 * start offline: the client bundle and the public files.
 */
function serviceWorker(): Plugin {
	return {
		name: "track:service-worker",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "client",
		async generateBundle(_options, bundle) {
			const { publicDir } = this.environment.config;
			const publicFiles = readdirSync(publicDir, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
			const bundled = Object.values(bundle)
				.map((output) => output.fileName)
				.filter((name) => !name.endsWith(".map") && !name.startsWith("."));
			const files = [...bundled, ...publicFiles].map((name) => `/${name}`).sort();

			// Bundle files are named by their content; public files are not, so theirs counts too.
			const hash = createHash("sha256").update(files.join("\n"));
			for (const name of publicFiles) hash.update(readFileSync(join(publicDir, name)));
			const build = { version: hash.digest("hex").slice(0, 16), files };

			const source = readFileSync(new URL("service-worker/sw.ts", import.meta.url), "utf8");
			const { code } = await transformWithOxc(source, "sw.ts");
			this.emitFile({
				type: "asset",
				fileName: "sw.js",
				source: `const BUILD = ${JSON.stringify(build)};\n${code}`,
			});
		},
	};
}

/** The names (never the values) of the keys .dev.vars sets to something. */
function devVarsKeys(): Set<string> {
	try {
		const text = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");
		return new Set(
			[...text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*\S/gm)].map((match) => match[1] ?? ""),
		);
	} catch {
		return new Set();
	}
}
