import { afterEach, describe, expect, it, vi } from "vitest";
import { tellOfSpentTries } from "./password-tries";

const verified = { id: "u-ada", email: "ada@example.com", emailVerified: true };

function recordingMailer() {
	const sent: string[] = [];
	return {
		sent,
		mailer: {
			send: async (email: { to: string }) => {
				sent.push(email.to);
			},
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tellOfSpentTries", () => {
	it("sends one to a verified address when the day's email is free", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, async () => true);
		expect(sent).toEqual(["ada@example.com"]);
	});

	it("sends none once the day's email has gone", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, async () => false);
		expect(sent).toEqual([]);
	});

	it("does not use up the day's email when there is nothing to send, or nobody to send it to", async () => {
		const allowEmail = vi.fn(async () => true);
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, undefined, allowEmail);
		await tellOfSpentTries({ ...verified, emailVerified: false }, mailer, allowEmail);
		expect(allowEmail).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("sends none without a way to hold it to one a day", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, undefined);
		expect(sent).toEqual([]);
	});

	it("resolves when sending fails, and logs what kind of failure and nothing of the person", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failed = new TypeError(`could not reach ${verified.email}`);
		await expect(
			tellOfSpentTries(verified, { send: () => Promise.reject(failed) }, async () => true),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("TypeError");
		expect(warn.mock.calls[0]?.join(" ")).not.toContain(verified.email);
	});

	it("resolves when counting fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { mailer, sent } = recordingMailer();
		await expect(
			tellOfSpentTries(verified, mailer, () => Promise.reject(new Error("no"))),
		).resolves.toBeUndefined();
		expect(sent).toEqual([]);
	});
});
