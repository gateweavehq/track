import type { BrowserContext, WebSocketRoute } from "@playwright/test";

/**
 * Takes a browser context offline, and back.
 *
 * `context.setOffline(true)` stops new requests, including the service worker's, but Chromium
 * leaves a WebSocket that is already open running. A real lost connection ends it, so the
 * sync sockets go through `routeWebSocket` and are closed on the way offline. While offline,
 * new sockets are refused, so the client's retries fail the way they do without a network.
 */
export class Network {
	#context: BrowserContext;
	#offline = false;
	#open = new Set<WebSocketRoute>();

	private constructor(context: BrowserContext) {
		this.#context = context;
	}

	/** Start routing the context's sync sockets. Call before the app opens its first one. */
	static async attach(context: BrowserContext): Promise<Network> {
		const network = new Network(context);
		await context.routeWebSocket(/\/api\/sync\/[^/]+\/socket/, (socket) => {
			if (network.#offline) {
				void socket.close();
				return;
			}
			network.#open.add(socket);
			socket.connectToServer();
			socket.onClose(() => network.#open.delete(socket));
		});
		return network;
	}

	async goOffline(): Promise<void> {
		this.#offline = true;
		await this.#context.setOffline(true);
		await Promise.all([...this.#open].map((socket) => socket.close()));
		this.#open.clear();
	}

	async goOnline(): Promise<void> {
		this.#offline = false;
		await this.#context.setOffline(false);
	}
}
