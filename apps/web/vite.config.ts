import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, transformWithOxc } from "vite";
import { devSecrets } from "./scripts/dev-secrets";

/** Where the end-to-end tests reach the app (see e2e/server.mjs). */
const E2E_ORIGIN = `http://localhost:${Number(process.env.TRACK_E2E_PORT) || 4711}`;
const E2E_PROVIDER = `http://localhost:${(Number(process.env.TRACK_E2E_PORT) || 4711) + 40}`;

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
				// The end-to-end build (e2e/build.mjs) pins the address the tests use, which is what
				// turns /mcp on, so the tests can play an agent. It also points at their stand-in for an
				// OpenID Connect provider (e2e/provider.mjs), and turns push on with a key of its own.
				const e2e = process.env.TRACK_E2E
					? {
							vars: {
								...config.vars,
								BETTER_AUTH_URL: E2E_ORIGIN,
								OIDC_ISSUER: E2E_PROVIDER,
								OIDC_CLIENT_ID: "track-e2e",
								OIDC_CLIENT_SECRET: "track-e2e-secret",
								OIDC_PROVIDER_NAME: "Test Provider",
								LEGAL_NOTICE_URL: "https://legal.example/notice",
								PRIVACY_POLICY_URL: "https://legal.example/privacy",
								TERMS_URL: "https://legal.example/terms",
								PUSH_VAPID_KEY: JSON.stringify(
									generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
										format: "jwk",
									}),
								),
							},
						}
					: {};
				if (command !== "serve") return e2e;
				// In dev only: `secrets.required` would drop the optional settings in .dev.vars.
				return {
					secrets: { required: devSecrets(config.secrets?.required ?? [], devVarsKeys()) },
					...e2e,
				};
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
