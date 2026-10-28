import type { MemberProfile } from "@gateweave/track-sync-server";
import { slugProblem } from "../../lib/slug";
import { db, getAuth } from "../auth";
import { schema } from "../db";
import { limitDemoStarts } from "../rate-limit";
import { workspaceStub } from "../workspaces";
import { assertDemo, VISITOR_DOMAIN } from "./mode";
import { type PersonKey, SAMPLE_PEOPLE, sampleSteps, WORKSPACE_NAME } from "./sample";

/** Thrown for problems the visitor should read, such as having asked too often. */
export class DemoError extends Error {}

/**
 * Gives a visitor a private sandbox: an account only the server can sign in to, and a workspace
 * named Acme with the sample people and issues, which cleanup deletes after a day. Returns the
 * workspace slug. The visitor's session cookie is set on the response of the server function
 * that calls this.
 */
export async function startDemoSandbox(headers: Headers): Promise<{ slug: string }> {
	assertDemo();

	// Cloudflare sets this to the address it saw; clients cannot choose it.
	const address = headers.get("cf-connecting-ip") ?? "unknown";
	const allowance = await limitDemoStarts(address);
	if (!allowance.allowed) {
		throw new DemoError(
			"You have opened a lot of demo workspaces. Try again in a little while, or deploy your own.",
		);
	}

	const auth = getAuth();
	const people = await ensureSamplePeople();

	// Direct `auth.api` calls skip HTTP: no sign-up refusal and no per-client rate limit, and
	// tanstackStartCookies puts the new session's cookie on the response. The password is never
	// shown to anyone; this account is only ever signed in to by this call.
	const { user } = await auth.api.signUpEmail({
		body: {
			name: "You",
			email: `${crypto.randomUUID()}@${VISITOR_DOMAIN}`,
			password: randomSecret(),
		},
	});

	const slug = `acme-${randomSuffix(6)}`;
	const problem = slugProblem(slug);
	if (problem) throw new Error(`Demo slug ${slug} is not valid: ${problem}`);
	// Creating through Better Auth fires the organization hooks, which sync membership to the
	// workspace's Durable Object. No headers: a server call names the owner in the body.
	const workspace = await auth.api.createOrganization({
		body: { name: WORKSPACE_NAME, slug, userId: user.id, keepCurrentActiveOrganization: true },
	});

	for (const [key, person] of SAMPLE_PEOPLE) {
		const userId = people[key].id;
		await auth.api.addMember({
			body: { userId, role: person.role, organizationId: workspace.id },
		});
	}

	const stub = workspaceStub(workspace.id);
	const steps = sampleSteps({
		userIds: Object.fromEntries(SAMPLE_PEOPLE.map(([key]) => [key, people[key].id])) as Record<
			PersonKey,
			string
		>,
		newId: () => crypto.randomUUID(),
	});
	for (const [index, { person, mutation }] of steps.entries()) {
		const result = await stub.mutate(people[person], "demo-sandbox", crypto.randomUUID(), mutation);
		if (!result.ok) {
			throw new Error(
				`Demo seeding failed at step ${index + 1} of ${steps.length} (${mutation.name}): ${result.reason}: ${result.message}`,
			);
		}
	}

	return { slug };
}

/**
 * The four sample people as users, created once. They are verified and have no credentials, so
 * nobody can sign in as them; they exist to be members of every sandbox and to author its issues.
 */
async function ensureSamplePeople(): Promise<Record<PersonKey, MemberProfile>> {
	const now = new Date();
	const people = {} as Record<PersonKey, MemberProfile>;
	for (const [key, person] of SAMPLE_PEOPLE) {
		const id = samplePersonId(key);
		await db
			.insert(schema.user)
			.values({
				id,
				name: person.name,
				email: person.email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		people[key] = { id, name: person.name, email: person.email, image: null, role: person.role };
	}
	return people;
}

/** Fixed, so every sandbox shares the same four users. */
export function samplePersonId(key: PersonKey): string {
	return `sample-${key}`;
}

function randomSecret(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function randomSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(byte) => alphabet[byte % alphabet.length],
	).join("");
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
