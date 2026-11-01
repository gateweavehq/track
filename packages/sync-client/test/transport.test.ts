import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTransport } from "../src";

/**
 * Stands in for the runtime's WebSocket, which a test drives by hand: some runtimes follow a
 * refused handshake's error with a close, as the standard says, and Node 22 does not.
 */
class FakeSocket {
	static last: FakeSocket | undefined;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		FakeSocket.last = this;
	}

	send(): void {}
	close(): void {}
}

function connect() {
	vi.stubGlobal("WebSocket", FakeSocket);
	const transport = httpTransport({ workspace: "acme", baseUrl: "http://track.test" });
	const handlers = { open: vi.fn(), message: vi.fn(), close: vi.fn() };
	transport.connect(handlers);
	const socket = FakeSocket.last;
	if (!socket) throw new Error("No socket");
	return { socket, handlers };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("httpTransport's socket", () => {
	it("opens at the workspace's socket URL", () => {
		const { socket } = connect();
		expect(socket.url).toBe("ws://track.test/api/sync/acme/socket");
	});

	it("reports a refused handshake as a close, where only an error comes", () => {
		const { socket, handlers } = connect();
		socket.onerror?.();
		expect(handlers.close).toHaveBeenCalledExactlyOnceWith(1006, "");
	});

	it("reports it once where the close follows the error", () => {
		const { socket, handlers } = connect();
		socket.onerror?.();
		socket.onclose?.({ code: 1006, reason: "" });
		expect(handlers.close).toHaveBeenCalledTimes(1);
	});

	it("leaves an error after opening to the close that follows it", () => {
		const { socket, handlers } = connect();
		socket.onopen?.();
		socket.onerror?.();
		expect(handlers.close).not.toHaveBeenCalled();
		socket.onclose?.({ code: 1011, reason: "Internal error" });
		expect(handlers.open).toHaveBeenCalledTimes(1);
		expect(handlers.close).toHaveBeenCalledExactlyOnceWith(1011, "Internal error");
	});
});
