import { describe, expect, it, vi } from "vitest";
import { createMailer, parseSender } from "./mailer";

describe("parseSender", () => {
	it("reads a named or a bare address", () => {
		expect(parseSender("Gateweave Track <track@example.com>")).toEqual({
			name: "Gateweave Track",
			email: "track@example.com",
		});
		expect(parseSender('"Track, by Gateweave" <track@example.com>')).toEqual({
			name: "Track, by Gateweave",
			email: "track@example.com",
		});
		expect(parseSender(" track@example.com ")).toBe("track@example.com");
		expect(parseSender("<track@example.com>")).toBe("track@example.com");
	});

	it("rejects anything that is not an address", () => {
		expect(parseSender("Gateweave Track")).toBeUndefined();
		expect(parseSender("Track <not an address>")).toBeUndefined();
		expect(parseSender("")).toBeUndefined();
	});
});

describe("createMailer", () => {
	const email = { to: "maya@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" };

	it("sends from the configured sender", async () => {
		const send = vi.fn(async () => ({ messageId: "1" }));
		const mailer = createMailer({ send } as unknown as SendEmail, "Track <track@example.com>");
		await mailer?.send(email);
		expect(send).toHaveBeenCalledWith({
			from: { name: "Track", email: "track@example.com" },
			...email,
		});
	});

	it("passes headers on", async () => {
		const send = vi.fn(async () => ({ messageId: "1" }));
		const mailer = createMailer({ send } as unknown as SendEmail, "track@example.com");
		const headers = { "List-Unsubscribe": "<https://track.example.com/api/unsubscribe/x>" };
		await mailer?.send({ ...email, headers });
		expect(send).toHaveBeenCalledWith({ from: "track@example.com", ...email, headers });
	});

	it("logs why a send failed, without the address, and still fails", async () => {
		const failure = Object.assign(new Error("maya@example.com is suppressed"), {
			code: "E_RECIPIENT_SUPPRESSED",
		});
		const send = vi.fn(async () => {
			throw failure;
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const mailer = createMailer({ send } as unknown as SendEmail, "track@example.com");

		await expect(mailer?.send(email)).rejects.toBe(failure);

		expect(logged).toHaveBeenCalledWith("email: a message was not sent", {
			code: "E_RECIPIENT_SUPPRESSED",
		});
		expect(JSON.stringify(logged.mock.calls)).not.toContain("maya@");
		logged.mockRestore();
	});

	it("logs a failure with no code as unknown", async () => {
		const send = vi.fn(async () => {
			throw new Error("Something else");
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const mailer = createMailer({ send } as unknown as SendEmail, "track@example.com");

		await expect(mailer?.send(email)).rejects.toThrow("Something else");

		expect(logged).toHaveBeenCalledWith("email: a message was not sent", { code: "unknown" });
		logged.mockRestore();
	});

	it("is off without a binding or a valid sender", () => {
		const binding = { send: vi.fn() } as unknown as SendEmail;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(createMailer(undefined, "track@example.com")).toBeUndefined();
		expect(createMailer(binding, undefined)).toBeUndefined();
		expect(createMailer(binding, "not an address")).toBeUndefined();
	});
});
