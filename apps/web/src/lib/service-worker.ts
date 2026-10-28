/** Installs the service worker that lets Track start without a connection (service-worker/). */
export function registerServiceWorker(): void {
	// Only built apps have one: in dev, Vite serves modules that a cached shell would go stale on.
	if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
		console.warn("Track could not install its service worker, so it cannot start offline", error);
	});
}
