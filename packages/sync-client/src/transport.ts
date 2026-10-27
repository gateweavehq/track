import type { Snapshot } from "@gateweave/track-protocol";

export interface SocketHandlers {
	open(): void;
	message(data: string): void;
	close(code: number, reason: string): void;
}

export interface SyncSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/** How the client reaches the sync gateway. Swappable for tests and other runtimes. */
export interface Transport {
	/** Fetches the full workspace state. Throws `HttpError` for HTTP failures. */
	snapshot(): Promise<Snapshot>;
	/**
	 * Checks that the gateway is reachable and still lets this user in, without fetching data.
	 * Used to find out why a socket could not be opened, since WebSockets do not expose the
	 * HTTP status of a failed handshake. Throws `HttpError` for HTTP failures.
	 */
	probe(): Promise<void>;
	/** Opens the sync socket. Handlers are always called asynchronously. */
	connect(handlers: SocketHandlers): SyncSocket;
}

export class HttpError extends Error {
	constructor(readonly status: number) {
		super(`Sync gateway responded with ${status}`);
		this.name = "HttpError";
	}
}

export interface HttpTransportOptions {
	/** Workspace slug. */
	workspace: string;
	/** Origin of the app. Defaults to the current page's origin. */
	baseUrl?: string;
}

/** Talks to the app's sync gateway with `fetch` and `WebSocket`. */
export function httpTransport({ workspace, baseUrl }: HttpTransportOptions): Transport {
	const base = `${baseUrl ?? globalThis.location.origin}/api/sync/${encodeURIComponent(workspace)}`;

	async function request(method: "GET" | "HEAD"): Promise<Response> {
		const response = await fetch(`${base}/snapshot`, {
			method,
			credentials: "same-origin",
			cache: "no-store",
		});
		if (!response.ok) throw new HttpError(response.status);
		return response;
	}

	return {
		async snapshot() {
			return (await (await request("GET")).json()) as Snapshot;
		},
		async probe() {
			await request("HEAD");
		},
		connect(handlers) {
			const ws = new WebSocket(`${base.replace(/^http/, "ws")}/socket`);
			ws.onopen = () => handlers.open();
			ws.onmessage = (event) => {
				if (typeof event.data === "string") handlers.message(event.data);
			};
			ws.onclose = (event) => handlers.close(event.code, event.reason);
			return {
				send: (data) => ws.send(data),
				close: (code, reason) => ws.close(code, reason),
			};
		},
	};
}
