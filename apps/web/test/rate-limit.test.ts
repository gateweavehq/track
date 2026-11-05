import { afterAll, beforeAll, expect, it } from "vitest";
import { startTrack } from "./track-worker";

// Better Auth turns its limiter on only when NODE_ENV is "production", which a Worker never sets,
// so the deployed app took unlimited password guesses (TRK-23). Once on, it counted in each
// isolate's memory, so every isolate gave an attacker a fresh allowance (TRK-24).

const origin = "https://track.test";

let track: Awaited<ReturnType<typeof startTrack>>;

beforeAll(async () => {
	track = await startTrack(origin, { isolates: 2 });
});

afterAll(async () => {
	await track?.dispose();
});

async function signIn(headers: Record<string, string>, isolate = 0) {
	const response = await track.fetchIn(isolate, `${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...headers },
		body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
	});
	return response.status;
}

it("limits sign-in attempts from one client", async () => {
	const client = { "cf-connecting-ip": "203.0.113.7" };
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signIn(client));
	expect(statuses).toEqual([401, 401, 401, 429]);

	expect(await signIn({ "cf-connecting-ip": "203.0.113.8" })).toBe(401);
});

it("tells clients apart by the address Cloudflare saw, not one they claim", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({
				"cf-connecting-ip": "198.51.100.20",
				"x-forwarded-for": `192.0.2.${attempt + 1}`,
			}),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});

it("counts a client's attempts in every isolate together", async () => {
	const client = { "cf-connecting-ip": "203.0.113.30" };
	const statuses = [];
	for (const isolate of [0, 1, 0, 1]) statuses.push(await signIn(client, isolate));
	expect(statuses).toEqual([401, 401, 401, 429]);
	// Had the Durable Object failed, each isolate would have fallen back to its own count.
	expect(track.logs.filter((log) => log.message.startsWith("rate limit:"))).toEqual([]);
});

// Every Worker reaches another zone from this one address, whoever runs it (TRK-92).
const WORKERS = "2a06:98c0:3600::103";

it("counts Workers on different zones apart", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(await signIn({ "cf-connecting-ip": WORKERS, "cf-worker": "one.example" }));
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
	expect(await signIn({ "cf-connecting-ip": WORKERS, "cf-worker": "other.example" })).toBe(401);
});

it("gives nobody a way out of a limit by saying they are a Worker", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({ "cf-connecting-ip": "203.0.113.60", "cf-worker": `zone-${attempt}.example` }),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});

// The default limit gives one back every tenth of a second, so what is tested has to come during the junk.
it.each([
	["a read from Better Auth", "/api/auth/get-session"],
	["an OAuth discovery document", "/.well-known/oauth-authorization-server"],
])("counts Workers on different zones apart for %s", async (_name, path) => {
	const get = (zone: string) =>
		track.fetchIn(0, `${origin}${path}`, {
			headers: { "cf-connecting-ip": WORKERS, "cf-worker": zone },
		});
	const statuses = new Set<number>();
	const someJunk = async (size: number) => {
		const answers = await Promise.all(Array.from({ length: size }, () => get("junk.example")));
		for (const answer of answers) statuses.add(answer.status);
	};
	for (let sent = 0; sent < 110; sent += 5) await someJunk(5);
	let answered = false;
	const junk = (async () => {
		while (!answered) await someJunk(2);
	})();
	const answer = await get("other.example").finally(() => {
		answered = true;
	});
	await junk;
	expect(statuses).toContain(429);
	expect(answer.status).not.toBe(429);
});

it("limits how fast one client creates workspaces, each a Durable Object", async () => {
	const client = { "cf-connecting-ip": "203.0.113.40" };
	const signedUp = await track.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...client },
		body: JSON.stringify({ name: "Busy", email: "busy@example.com", password: "a-long-password" }),
	});
	expect(signedUp.status).toBe(200);
	const cookie = signedUp.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");

	const statuses = [];
	for (let n = 0; n < 11; n++) {
		const response = await track.fetch(`${origin}/api/auth/organization/create`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie, ...client },
			body: JSON.stringify({ name: `Workspace ${n}`, slug: `busy-${n}` }),
		});
		statuses.push(response.status);
	}
	expect(statuses).toEqual([...Array(10).fill(200), 429]);
});
