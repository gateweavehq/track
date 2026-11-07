import { CloseCode, PING, PONG } from "@gateweave/track-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTrack } from "./track-worker";

// Changing a name or a password on the account page (TRK-110). The cookie behind either request may
// be a stolen one, so a rename can reach a name and nothing else, and a new password needs the old
// one, a limit on guesses, and an email to the person.

const origin = "https://track.test";
const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin);
});

afterAll(async () => {
	await track?.dispose();
});

let clients = 0;
/** Each test counts as its own client, so that rate limits stay out of what it is about. */
const newClient = () => `203.0.113.${++clients}`;

function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return track.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body ?? {}),
	});
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

async function signUp(client: string, name: string, email: string) {
	const response = await authApi("/sign-up/email", {
		client,
		body: { name, email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	return { id: user.id, email, cookie: cookieOf(response) };
}

function signIn(client: string, email: string, password: string) {
	return authApi("/sign-in/email", { client, body: { email, password } });
}

async function isSignedIn(cookie: string) {
	const response = await track.fetch(`${origin}/api/auth/get-session`, {
		headers: { origin, cookie, "cf-connecting-ip": "203.0.113.250" },
	});
	return (await response.json()) !== null;
}

function userRow(id: string) {
	return track.db
		.prepare("SELECT name, image FROM user WHERE id = ?")
		.bind(id)
		.first<{ name: string; image: string | null }>();
}

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

/** Opens a sync socket as a signed-in browser would, which also tells the workspace who they are. */
async function openSocket(slug: string, cookie: string) {
	const { status, ws } = await track.socket(`${origin}/api/sync/${slug}/socket`, {
		origin,
		cookie,
	});
	expect(status).toBe(101);
	if (!ws) throw new Error("No socket");
	const closed: { code?: number } = {};
	ws.addEventListener("close", (event) => {
		closed.code = event.code;
	});
	const pong = new Promise((resolve) => ws.addEventListener("message", resolve, { once: true }));
	ws.send(PING);
	expect(((await pong) as MessageEvent).data).toBe(PONG);
	return closed;
}

describe("changing a name", () => {
	it("reaches the workspaces they are in", async () => {
		const client = newClient();
		const person = await signUp(client, "Remy", "remy@account.test");
		const created = await authApi("/organization/create", {
			client,
			cookie: person.cookie,
			body: { name: "Renamers", slug: "renamers" },
		});
		const { id: workspaceId } = (await created.json()) as { id: string };
		await openSocket("renamers", person.cookie);

		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: "Remy Rivers" },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe("Remy Rivers");

		await vi.waitFor(async () => {
			const { members } = await track.directory(workspaceId);
			expect(members).toContainEqual(
				expect.objectContaining({ id: person.id, name: "Remy Rivers" }),
			);
		});
	});

	it("keeps it without the spaces around it", async () => {
		const client = newClient();
		const person = await signUp(client, "Sana", "sana@account.test");
		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: "  Sana Sol  " },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe("Sana Sol");
	});

	// The picture is an address other members' browsers fetch, so this is not only about tidiness.
	it.each([
		["a picture beside it", { name: "Taken", image: "https://elsewhere.test/a.png" }],
		["a picture alone", { image: "https://elsewhere.test/a.png" }],
		["an address", { name: "Taken", email: "other@account.test" }],
		["a verified address", { name: "Taken", emailVerified: true }],
		["no name at all", {}],
	])("takes nothing but a name: %s", async (_what, body) => {
		const client = newClient();
		const person = await signUp(client, "Tess", `tess-${client}@account.test`);
		const refused = await authApi("/update-user", { client, cookie: person.cookie, body });
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect(await userRow(person.id)).toEqual({ name: "Tess", image: null });
	});

	it.each([
		["empty", ""],
		["only spaces", "   "],
		["too long", "x".repeat(101)],
		["not text", 42],
	])("refuses one that is %s", async (_what, name) => {
		const client = newClient();
		const person = await signUp(client, "Uma", `uma-${client}@account.test`);
		const refused = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name },
		});
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect((await userRow(person.id))?.name).toBe("Uma");
	});

	it("takes the longest one it allows", async () => {
		const client = newClient();
		const person = await signUp(client, "Vic", "vic@account.test");
		const longest = "x".repeat(100);
		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: longest },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe(longest);
	});

	// Each rename is a write to every workspace they are in.
	it("stops at ten a minute", async () => {
		const client = newClient();
		const person = await signUp(client, "Wes", "wes@account.test");
		const rename = (name: string) =>
			authApi("/update-user", { client, cookie: person.cookie, body: { name } });
		for (let tries = 0; tries < 10; tries++) {
			expect((await rename(`Wes ${tries}`)).status).toBe(200);
		}
		expect((await rename("Wes again")).status).toBe(429);
		expect((await userRow(person.id))?.name).toBe("Wes 9");
	});

	it("needs a session", async () => {
		const refused = await authApi("/update-user", {
			client: newClient(),
			body: { name: "Nobody" },
		});
		expect(refused.status).toBe(401);
	});
});

describe("signing up", () => {
	it.each([
		["only spaces", "   "],
		["too long", "x".repeat(101)],
	])("refuses a name that is %s, as renaming does", async (_what, name) => {
		const client = newClient();
		const email = `name-${client}@account.test`;
		const refused = await authApi("/sign-up/email", {
			client,
			body: { name, email, password: PASSWORD },
		});
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
	});

	it("keeps a name without the spaces around it", async () => {
		const person = await signUp(newClient(), "  Xan  ", "xan@account.test");
		expect((await userRow(person.id))?.name).toBe("Xan");
	});
});

describe("changing a password", () => {
	const change = (
		client: string,
		cookie: string,
		currentPassword: string,
		newPassword: string,
		rest: object = {},
	) =>
		authApi("/change-password", {
			client,
			cookie,
			body: { currentPassword, newPassword, ...rest },
		});

	const toldAbout = async (email: string) =>
		(await track.emails()).filter(
			(each) => each.to === email && each.subject === "Your Gateweave Track password was changed",
		);

	it("needs the current one, and leaves everything as it was without it", async () => {
		const client = newClient();
		const person = await signUp(client, "Yara", "yara@account.test");
		const refused = await change(client, person.cookie, "not-the-password", NEW_PASSWORD);
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_PASSWORD");

		expect(await isSignedIn(person.cookie)).toBe(true);
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
		expect((await signIn(newClient(), person.email, NEW_PASSWORD)).status).toBe(401);
		expect(await toldAbout(person.email)).toEqual([]);
	});

	// Someone holding a stolen cookie would otherwise have a way to guess at the password.
	it("stops counting guesses at five a minute", async () => {
		const client = newClient();
		const person = await signUp(client, "Zed", "zed@account.test");
		const guess = () => change(client, person.cookie, "a-guess", NEW_PASSWORD);
		for (let tries = 0; tries < 5; tries++) expect((await guess()).status).toBe(400);
		expect((await guess()).status).toBe(429);
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
	});

	it("refuses a new one that is too short", async () => {
		const client = newClient();
		const person = await signUp(client, "Abe", "abe@account.test");
		const refused = await change(client, person.cookie, PASSWORD, "short");
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("PASSWORD_TOO_SHORT");
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
	});

	it("needs a session", async () => {
		const refused = await authApi("/change-password", {
			client: newClient(),
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});
		expect(refused.status).toBe(401);
	});

	it("lets them sign in with the new one and not the old", async () => {
		const client = newClient();
		const person = await signUp(client, "Bea", "bea@account.test");
		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD);
		expect(changed.status).toBe(200);
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(401);
		expect((await signIn(newClient(), person.email, NEW_PASSWORD)).status).toBe(200);
	});

	it("ends every other session and its sockets, and keeps this browser signed in", async () => {
		const client = newClient();
		const person = await signUp(client, "Cal", "cal@account.test");
		const created = await authApi("/organization/create", {
			client,
			cookie: person.cookie,
			body: { name: "Changers", slug: "changers" },
		});
		expect(created.status).toBe(200);
		const elsewhere = cookieOf(await signIn(newClient(), person.email, PASSWORD));
		const socket = await openSocket("changers", elsewhere);
		const ownSocket = await openSocket("changers", person.cookie);

		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD);
		expect(changed.status).toBe(200);

		expect(await isSignedIn(elsewhere)).toBe(false);
		await vi.waitFor(() => expect(socket.code).toBe(CloseCode.SessionEnded));
		// This browser's session is replaced too, so its other tabs reconnect with the new cookie.
		await vi.waitFor(() => expect(ownSocket.code).toBe(CloseCode.SessionEnded));
		expect(await isSignedIn(person.cookie)).toBe(false);
		expect(await isSignedIn(cookieOf(changed))).toBe(true);
	});

	// Whoever knew the old password may be why it is changing, and may be the one asking.
	it("ends other sessions even when the request asks to keep them", async () => {
		const client = newClient();
		const person = await signUp(client, "Dov", "dov@account.test");
		const elsewhere = cookieOf(await signIn(newClient(), person.email, PASSWORD));
		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD, {
			revokeOtherSessions: false,
		});
		expect(changed.status).toBe(200);
		expect(await isSignedIn(elsewhere)).toBe(false);
	});

	it("tells the person by email, without the password", async () => {
		const client = newClient();
		const person = await signUp(client, "Eda", "eda@account.test");
		expect((await change(client, person.cookie, PASSWORD, NEW_PASSWORD)).status).toBe(200);
		await vi.waitFor(async () => expect(await toldAbout(person.email)).toHaveLength(1));
		const [mail] = await toldAbout(person.email);
		expect(JSON.stringify(mail)).not.toContain(NEW_PASSWORD);
	});
});
