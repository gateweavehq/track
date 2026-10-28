// Track's service worker. It lets the app start with no connection: it keeps this build's files,
// and when a page cannot be fetched it serves the app shell instead. The routes then load in the
// browser, from the device's copy of the workspace. Pages are always fetched from the network
// first, so online, nothing changes.
//
// The shell is what the server renders for a workspace URL, whose route is client-only: the root
// layout and this build's scripts, with no data. `_shell` can never be a workspace's slug, and
// the router loads the real route for whichever URL the shell is served at.
//
// Built into /sw.js by the `serviceWorker` plugin in vite.config.ts, which defines BUILD.

declare const BUILD: {
	/** Changes whenever any of the files does. */
	version: string;
	/** Absolute paths: the client bundle and the public files. */
	files: string[];
};

const worker = self as unknown as ServiceWorkerGlobalScope;

const SHELL = "/_shell";
const CACHE = `track-${BUILD.version}`;
const FILES = new Set(BUILD.files);

/** Paths that are never pages: the API, MCP and OAuth metadata. */
const NOT_PAGES = /^\/(?:api\/|mcp(?:\/|$)|\.well-known\/)/;

worker.addEventListener("install", (event) => {
	event.waitUntil(install());
});

worker.addEventListener("activate", (event) => {
	event.waitUntil(activate());
});

worker.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== worker.location.origin) return;

	if (request.mode === "navigate") {
		if (!NOT_PAGES.test(url.pathname)) event.respondWith(page(request));
	} else if (FILES.has(url.pathname)) {
		event.respondWith(file(request, url.pathname));
	}
});

async function install(): Promise<void> {
	const cache = await caches.open(CACHE);
	await Promise.all(
		BUILD.files.map(async (path) => {
			// Bundle files are named by their content, so a copy from an earlier version is current.
			const kept = path.startsWith("/assets/") ? await caches.match(path) : undefined;
			await cache.put(path, kept ?? (await download(path)));
		}),
	);
	// Last, because it names this build's files, which are all in the cache by now.
	await cache.put(SHELL, await download(SHELL));
	await worker.skipWaiting();
}

async function activate(): Promise<void> {
	const names = await caches.keys();
	await Promise.all(
		names
			.filter((name) => name.startsWith("track-") && name !== CACHE)
			.map((name) => caches.delete(name)),
	);
	await worker.clients.claim();
}

async function page(request: Request): Promise<Response> {
	try {
		return await fetch(request);
	} catch (error) {
		const shell = await caches.match(SHELL, { cacheName: CACHE });
		if (shell) return shell;
		throw error;
	}
}

async function file(request: Request, path: string): Promise<Response> {
	return (await caches.match(path, { cacheName: CACHE })) ?? fetch(request);
}

async function download(path: string): Promise<Response> {
	// Past the HTTP cache: a stale file under a fresh version would be kept until the next one.
	const response = await fetch(path, { cache: "no-cache" });
	if (!response.ok) throw new Error(`${path}: ${response.status}`);
	return response;
}
