import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema } from "../db";
import { faulty, LOCAL, migratedD1 } from "../db/faulty-d1";
import { READ_ATTEMPTS } from "../db/retry-reads";
import { type AuthConfig, createAuth } from "./config";
import { DELETE_ACCOUNT } from "./delete-account";

// The hooks that read a request's session to decide, and leave a request with none to the
// endpoint: on listing a workspace's invitations and on counting password tries. Each refuses
// when a session cookie came and the session could not be read. See "When a guard cannot read
// the session" in docs/architecture.md.

let real: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ d1: real, dispose } = await migratedD1("session-of-test"));
	// As the Worker tests do, so that a test can make people at will.
	await real.prepare("UPDATE deployment SET sign_up = 'open' WHERE id = 1").run();
});

afterAll(async () => {
	await dispose?.();
});

beforeEach(() => {
	// A failed query is logged, by this app and by Better Auth, and these tests make many.
	for (const level of ["error", "warn", "info", "log", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation(() => {});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";
const baseURL = "https://track.test";

/** Only the read of a session, so that everything else a request asks is answered. */
const SESSION_READ = /^select .* from "session"/i;

/**
 * The two ways a read fails for the one who asked: a failure that passes, on every attempt it is
 * given, and one that is not sent again at all.
 */
const FAILED_READS: [how: string, failures: number, message: string][] = [
	["on every attempt it is given", READ_ATTEMPTS, LOCAL],
	["in a way that is not sent again", 1, "D1_ERROR: D1 DB is overloaded."],
];

let clients = 0;
/** Each request from an address of its own, so that no rate limit answers for a hook. */
const newClient = () => `203.0.113.${++clients % 250}`;

function authOn(d1: D1Database, settings: Partial<AuthConfig> = {}) {
	const db = createDb(d1);
	const auth = createAuth({
		db,
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL,
		...settings,
	});
	return { db, auth };
}

const cookieOf = (headers: Headers) =>
	headers
		.getSetCookie()
		.map((line) => line.split(";")[0])
		.join("; ");

/** Someone with a password and a session, on a database that fails when told to. */
async function signedUp(email: string, settings: Partial<AuthConfig> = {}) {
	const { database, state } = faulty(real);
	const { db, auth } = authOn(database, settings);
	const { headers, response } = await auth.api.signUpEmail({
		body: { name: "Rio", email, password: PASSWORD },
		returnHeaders: true,
	});
	return { id: response.user.id, email, db, auth, cookie: cookieOf(headers), state };
}

type Person = Awaited<ReturnType<typeof signedUp>>;

async function send(
	person: Pick<Person, "auth">,
	path: string,
	{ cookie, body }: { cookie?: string | undefined; body?: object | undefined } = {},
) {
	const response = await person.auth.handler(
		new Request(`${baseURL}/api/auth${path}`, {
			method: body ? "POST" : "GET",
			headers: {
				origin: baseURL,
				"cf-connecting-ip": newClient(),
				...(cookie && { cookie }),
				...(body && { "content-type": "application/json" }),
			},
			...(body && { body: JSON.stringify(body) }),
		}),
	);
	const text = await response.text();
	let answer: { code?: string; message?: string } = {};
	try {
		answer = JSON.parse(text) as typeof answer;
	} catch {}
	return {
		status: response.status,
		code: answer.code,
		message: answer.message,
		text,
		cookie: cookieOf(response.headers),
	};
}

/** Fails the next read of a session as told, and says afterwards whether one was failed. */
function failTheSessionRead({ state }: Person, failures: number, message: string) {
	state.only = SESSION_READ;
	state.failures = failures;
	state.message = message;
	return () => state.failures === 0;
}

const sessionReads = ({ state }: Pick<Person, "state">) =>
	state.sent.filter((query) => SESSION_READ.test(query));

/**
 * A workspace of the owner's with one invitation waiting, and a plain member, who may not
 * invite.
 */
async function workspaceWithInvitation(owner: Person, member: Person, slug: string) {
	const headers = new Headers({ cookie: owner.cookie, origin: baseURL });
	const workspace = await owner.auth.api.createOrganization({
		body: { name: slug, slug },
		headers,
	});
	const invited = `invited-${slug}@guards.test`;
	const invitation = await owner.auth.api.createInvitation({
		body: { email: invited, role: "member", organizationId: workspace.id },
		headers,
	});
	await owner.db.insert(schema.member).values({
		id: `m-${member.id}-${slug}`,
		organizationId: workspace.id,
		userId: member.id,
		role: "member",
		createdAt: new Date(),
	});
	return {
		list: `/organization/list-invitations?organizationId=${workspace.id}`,
		invitationId: invitation.id,
		invited,
	};
}

async function passwordOf({ db, id }: Person) {
	const row = await db
		.select({ password: schema.account.password })
		.from(schema.account)
		.where(eq(schema.account.userId, id))
		.get();
	return row?.password ?? undefined;
}

const sessionsOf = ({ db, id }: Person) =>
	db
		.select({ id: schema.session.id })
		.from(schema.session)
		.where(eq(schema.session.userId, id))
		.all();

const accountOf = ({ db, id }: Person) =>
	db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, id)).get();

/** The cookie with its signature changed, as one that this server never set. */
function tampered(cookie: string) {
	const last = cookie.at(-1) === "A" ? "B" : "A";
	return `${cookie.slice(0, -1)}${last}`;
}

describe.each(FAILED_READS)("when the read of a session fails %s", (_how, failures, message) => {
	it("a workspace's invitations are not listed", async () => {
		const owner = await signedUp(`owner-${failures}@guards.test`);
		const member = await signedUp(`member-${failures}@guards.test`);
		const { list, invitationId, invited } = await workspaceWithInvitation(
			owner,
			member,
			`failed-${failures}`,
		);
		const failed = failTheSessionRead(member, failures, message);

		const answer = await send(member, list, { cookie: member.cookie });

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		expect(answer.text).not.toContain(invitationId);
		expect(answer.text).not.toContain(invited);
		// And the session it came with is the one there still is.
		expect(await sessionsOf(member)).toHaveLength(1);
	});

	it("a password is not changed past what a person's sessions may try", async () => {
		const asked: string[] = [];
		const person = await signedUp(`tries-${failures}@guards.test`, {
			allowPasswordTry: async (userId) => {
				asked.push(userId);
				return false;
			},
		});
		const before = await passwordOf(person);
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		// Nobody was named to count against, and the password is what it was.
		expect(asked).toEqual([]);
		expect(before).toBeTruthy();
		expect(await passwordOf(person)).toBe(before);
		expect(await sessionsOf(person)).toHaveLength(1);
	});

	it("an account is not deleted past what a person's sessions may try", async () => {
		const asked: string[] = [];
		const person = await signedUp(`delete-${failures}@guards.test`, {
			allowPasswordTry: async (userId) => {
				asked.push(userId);
				return false;
			},
		});
		const failed = failTheSessionRead(person, failures, message);

		const answer = await send(person, DELETE_ACCOUNT, {
			cookie: person.cookie,
			body: { password: PASSWORD },
		});

		expect(answer.status).toBe(500);
		expect(failed()).toBe(true);
		expect(asked).toEqual([]);
		expect(await accountOf(person)).toEqual({ id: person.id });
	});
});

describe("when the session cannot be read at all", () => {
	it("a hook answers 500, and so does the endpoint behind it", async () => {
		const owner = await signedUp("owner-gone@guards.test");
		const member = await signedUp("member-gone@guards.test");
		const { list, invitationId } = await workspaceWithInvitation(owner, member, "gone");
		member.state.only = SESSION_READ;
		member.state.failures = 100;

		const answer = await send(member, list, { cookie: member.cookie });

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain(invitationId);
	});
});

// What the hooks did before, and still do: with the database answering, a session decides, and
// someone with no session gets the endpoint's own answer.
describe("when the database answers", () => {
	it("invitations are listed for someone who may invite, and for nobody else", async () => {
		const owner = await signedUp("owner@guards.test");
		const member = await signedUp("member@guards.test");
		const stranger = await signedUp("stranger@guards.test");
		const { list, invitationId } = await workspaceWithInvitation(owner, member, "answers");
		member.state.sent.length = 0;

		const refused = await send(member, list, { cookie: member.cookie });

		expect(refused).toMatchObject({ status: 403, message: "Only admins can see invitations" });
		expect(refused.text).not.toContain(invitationId);
		// The session is read once, as it was.
		expect(sessionReads(member)).toHaveLength(1);

		owner.state.sent.length = 0;
		const listed = await send(owner, list, { cookie: owner.cookie });
		expect(listed.status).toBe(200);
		expect(listed.text).toContain(invitationId);
		expect(sessionReads(owner)).toHaveLength(1);

		const outside = await send(stranger, list, { cookie: stranger.cookie });
		expect(outside.status).toBe(403);
		expect(outside.text).not.toContain(invitationId);
	});

	it("a person whose tries are spent is told so, and one with tries left goes on", async () => {
		const spent = await signedUp("spent@guards.test", { allowPasswordTry: async () => false });
		const before = await passwordOf(spent);

		const answer = await send(spent, "/change-password", {
			cookie: spent.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(answer).toMatchObject({ status: 429, code: "TOO_MANY_PASSWORD_TRIES" });
		expect(await passwordOf(spent)).toBe(before);

		const asked: string[] = [];
		const person = await signedUp("left@guards.test", {
			allowPasswordTry: async (userId) => {
				asked.push(userId);
				return true;
			},
		});
		person.state.sent.length = 0;
		const changed = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});
		expect(changed.status).toBe(200);
		expect(asked).toEqual([person.id]);
		expect(await passwordOf(person)).not.toBe(await passwordOf(spent));
	});

	it.each([
		["/organization/list-invitations?organizationId=any", undefined],
		["/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }],
		[DELETE_ACCOUNT, { password: PASSWORD }],
	])("someone with no cookie gets the endpoint's own answer: %s", async (path, body) => {
		const { database, state } = faulty(real);
		const { auth } = authOn(database, { allowPasswordTry: async () => false });
		state.sent.length = 0;

		const answer = await send({ auth }, path, { body });

		expect(answer.status).toBe(401);
		// Nobody to look up: the hooks ask the database nothing.
		expect(sessionReads({ state })).toEqual([]);
	});

	it("someone whose session has gone gets the endpoint's own answer, and signs in again", async () => {
		const asked: string[] = [];
		const person = await signedUp("signed-out@guards.test", {
			allowPasswordTry: async (userId) => {
				asked.push(userId);
				return false;
			},
		});
		await person.db.delete(schema.session).where(eq(schema.session.userId, person.id));

		const list = await send(person, "/organization/list-invitations?organizationId=any", {
			cookie: person.cookie,
		});
		const change = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(list.status).toBe(401);
		expect(change.status).toBe(401);
		expect(asked).toEqual([]);

		const again = await send(person, "/sign-in/email", {
			cookie: person.cookie,
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(200);
		expect(await sessionsOf(person)).toHaveLength(1);
		const found = await person.auth.api.getSession({
			headers: new Headers({ cookie: again.cookie }),
		});
		expect(found?.user.id).toBe(person.id);
	});

	it("someone whose session has ended gets the endpoint's own answer, and signs in again", async () => {
		const person = await signedUp("ended@guards.test", { allowPasswordTry: async () => false });
		await person.db
			.update(schema.session)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(schema.session.userId, person.id));

		const change = await send(person, "/change-password", {
			cookie: person.cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});
		expect(change.status).toBe(401);

		const again = await send(person, "/sign-in/email", {
			cookie: person.cookie,
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(200);
		const found = await person.auth.api.getSession({
			headers: new Headers({ cookie: again.cookie }),
		});
		expect(found?.user.id).toBe(person.id);
	});

	it("a cookie this server did not sign is nobody's, asks the database nothing, and its holder signs in again", async () => {
		const person = await signedUp("changed-cookie@guards.test", {
			allowPasswordTry: async () => false,
		});
		const cookie = tampered(person.cookie);
		person.state.sent.length = 0;

		const list = await send(person, "/organization/list-invitations?organizationId=any", {
			cookie,
		});
		const change = await send(person, "/change-password", {
			cookie,
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});

		expect(list.status).toBe(401);
		expect(change.status).toBe(401);
		expect(sessionReads(person)).toEqual([]);

		const again = await send(person, "/sign-in/email", {
			cookie,
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(200);
		const found = await person.auth.api.getSession({
			headers: new Headers({ cookie: again.cookie }),
		});
		expect(found?.user.id).toBe(person.id);
	});
});
