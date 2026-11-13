import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIntakeEmail } from "./intake-email";

// Mail to a request's reply address costs a full parse of the message, so the address is checked
// first (TRK-71). The Worker tests (test/intake-email.test.ts) cover what a reply files; these
// count the parses, which only a spy in the same process can see. Everything the gateway reaches
// beyond PostalMime is a stand-in.

const { DOMAIN, WORKSPACE, KEY, stub, limitEmailedReplies } = vi.hoisted(() => {
	const KEY = "abcdefgh234567qrstuvwxyz23";
	return {
		DOMAIN: "requests.track.test",
		WORKSPACE: "ws8xyz",
		KEY,
		stub: {
			replyTarget: vi.fn(async (key: string) =>
				key === KEY ? { email: "sam@customer.test" } : null,
			),
			fileReply: vi.fn(async (_reply: unknown) => true),
		},
		limitEmailedReplies: vi.fn(async () => true),
	};
});

vi.mock("cloudflare:workers", () => ({ env: { INTAKE_EMAIL_DOMAIN: DOMAIN } }));
vi.mock("./auth", () => ({
	db: {
		select: () => ({ from: () => ({ where: () => ({ get: async () => ({ id: WORKSPACE }) }) }) }),
	},
}));
vi.mock("./demo/mode", () => ({ demoEnabled: () => false }));
vi.mock("./file-quota", () => ({ releaseFileStorage: vi.fn(), reserveFileStorage: vi.fn() }));
vi.mock("./files", () => ({ mediaType: (type: string) => type }));
vi.mock("./rate-limit", () => ({
	limitEmailedReplies: () => limitEmailedReplies(),
	limitEmailedRequests: vi.fn(async () => true),
}));
vi.mock("./workspaces", () => ({ findWorkspaceStub: async () => stub }));

function reply(from: string, to: string) {
	const raw = [
		`From: ${from}`,
		`To: ${to}`,
		"Subject: Re: Your request was accepted",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Thanks, that helps.",
		"",
	].join("\r\n");
	const rejected: string[] = [];
	const message = {
		from,
		to,
		raw: new Response(raw).body,
		rawSize: raw.length,
		headers: new Headers(),
		setReject: (reason: string) => {
			rejected.push(reason);
		},
	} as unknown as ForwardableEmailMessage;
	return { message, rejected };
}

let parse: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	parse = vi.spyOn(PostalMime, "parse");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("replies by email", () => {
	it("refuses a key of another form without reading the message", async () => {
		const { message, rejected } = reply(
			"sam@customer.test",
			`${WORKSPACE}.abcdefgh234567qrstuvwx@${DOMAIN}`,
		);
		await handleIntakeEmail(message);
		expect(rejected).toEqual(["No such address"]);
		expect(parse).not.toHaveBeenCalled();
		expect(stub.replyTarget).not.toHaveBeenCalled();
	});

	it("refuses a key no request has without reading the message", async () => {
		const { message, rejected } = reply(
			"sam@customer.test",
			`${WORKSPACE}.zzzzzzzzzzzzzzzzzzzzzzzzzz@${DOMAIN}`,
		);
		await handleIntakeEmail(message);
		// The same answer as mail to an address that does not exist at all.
		expect(rejected).toEqual(["No such address"]);
		expect(stub.replyTarget).toHaveBeenCalledWith("zzzzzzzzzzzzzzzzzzzzzzzzzz");
		expect(parse).not.toHaveBeenCalled();
		expect(limitEmailedReplies).not.toHaveBeenCalled();
	});

	it("refuses another sender once the message is read, before counting it", async () => {
		const { message, rejected } = reply("eve@elsewhere.test", `${WORKSPACE}.${KEY}@${DOMAIN}`);
		await handleIntakeEmail(message);
		expect(rejected).toEqual(["No such address"]);
		expect(parse).toHaveBeenCalledTimes(1);
		expect(limitEmailedReplies).not.toHaveBeenCalled();
		expect(stub.fileReply).not.toHaveBeenCalled();
	});

	it("files a reply from the address the decision went to", async () => {
		const { message, rejected } = reply("Sam@Customer.test", `${WORKSPACE}.${KEY}@${DOMAIN}`);
		await handleIntakeEmail(message);
		expect(rejected).toEqual([]);
		expect(parse).toHaveBeenCalledTimes(1);
		expect(stub.fileReply).toHaveBeenCalledWith({
			key: KEY,
			from: "sam@customer.test",
			body: "Thanks, that helps.",
		});
	});
});
