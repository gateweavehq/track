import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Settings Track runs without (see src/server/env.d.ts). `secrets.required` in wrangler.jsonc
 * stops a deploy that lacks BETTER_AUTH_SECRET, but in local dev it also drops every other key
 * from .dev.vars. So in dev, these are added to the list when .dev.vars sets them.
 */
const OPTIONAL_SECRETS = ["BETTER_AUTH_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"];

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		cloudflare({
			viteEnvironment: { name: "ssr" },
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
	],
}));

/** The names (never the values) of the keys .dev.vars sets to something. */
function devVarsKeys(): Set<string> {
	try {
		const text = readFileSync(new URL(".dev.vars", import.meta.url), "utf8");
		return new Set(
			[...text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*\S/gm)].map((match) => match[1] ?? ""),
		);
	} catch {
		return new Set();
	}
}
