import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// The service worker that lets Track start offline, as the build emits it, and the app shell it
// serves in place of a page it cannot fetch (service-worker/sw.ts).

const origin = "https://track.test";
const clientDir = resolve(import.meta.dirname, "../dist/client");

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

function readServiceWorker() {
	const source = readFileSync(join(clientDir, "sw.js"), "utf8");
	const json = /^const BUILD = (.+);$/m.exec(source)?.[1];
	if (!json) throw new Error("sw.js does not define BUILD");
	return { source, build: JSON.parse(json) as { version: string; files: string[] } };
}

it("is a plain script that keeps files this build has", () => {
	const { source, build } = readServiceWorker();
	// It is registered without `type: "module"`, which not every browser supports.
	expect(() => new Script(source)).not.toThrow();

	expect(build.files).toContain("/manifest.webmanifest");
	expect(build.files.some((file) => /^\/assets\/.+\.css$/.test(file))).toBe(true);
	expect(build.files.filter((file) => file === "/sw.js" || file.endsWith(".map"))).toEqual([]);
	const missing = build.files.filter((file) => !existsSync(join(clientDir, file)));
	expect(missing).toEqual([]);
});

it("has an app shell to serve, with this build's assets and no page in it", async () => {
	const response = await track.fetch(`${origin}/_shell`);
	expect(response.status).toBe(200);
	const html = await response.text();

	const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
	expect(assets.length).toBeGreaterThan(0);
	const { build } = readServiceWorker();
	expect(assets.filter((asset) => !build.files.includes(asset ?? ""))).toEqual([]);

	// The workspace route renders only in the browser, and `_shell` can be no workspace's slug.
	expect(html).not.toMatch(/Sign in|Workspace not found|Page not found/);
});

it("leaves every page to the Worker", () => {
	// Static HTML would be served in place of the page at its path, signed in or not.
	const pages = readdirSync(clientDir, { recursive: true }).filter((name) =>
		String(name).endsWith(".html"),
	);
	expect(pages).toEqual([]);
});
