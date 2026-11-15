import type { MemberProfile } from "@gateweave/track-sync-server";
import { eq } from "drizzle-orm";
import { slugProblem } from "../../lib/slug";
import { db, getAuth } from "../auth";
import { AGENT_EMAIL_DOMAIN, AGENT_ROLE, deleteOrphanedAgents } from "../auth/agents";
import { schema } from "../db";
import { limitDemoStarts } from "../rate-limit";
import { destroyWorkspace, findWorkspaceStub, syncMembership } from "../workspaces";
import { assertDemo, VISITOR_DOMAIN } from "./mode";
import {
	AGENT,
	AGENT_KEY,
	type AuthorKey,
	currentCycleId,
	type PersonKey,
	SAMPLE_PEOPLE,
	type SampleStep,
	sampleSteps,
	WORKSPACE_NAME,
	withCycle,
} from "./sample";

/** Thrown for problems the visitor should read, such as having asked too often. */
export class DemoError extends Error {}

/**
 * Gives a visitor a private sandbox: an account only the server can sign in to, and a workspace
 * named Acme with the sample people, agent and issues, which cleanup deletes after a day. Returns
 * the workspace slug. The visitor's session cookie is set on the response of the server function
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

	let workspaceId: string | undefined;
	try {
		const slug = `acme-${randomSuffix(6)}`;
		const problem = slugProblem(slug);
		if (problem) throw new Error(`Demo slug ${slug} is not valid: ${problem}`);
		// Creating through Better Auth fires the organization hooks, which sync membership to the
		// workspace's Durable Object. No headers: a server call names the owner in the body.
		const workspace = await auth.api.createOrganization({
			body: { name: WORKSPACE_NAME, slug, userId: user.id, keepCurrentActiveOrganization: true },
		});
		workspaceId = workspace.id;

		const agent = await addSampleAgent(workspace.id);
		for (const [key, person] of SAMPLE_PEOPLE) {
			const userId = people[key].id;
			await auth.api.addMember({
				body: { userId, role: person.role, organizationId: workspace.id },
			});
		}
		const members: Record<AuthorKey, MemberProfile> = { ...people, [AGENT_KEY]: agent };

		const stub = await findWorkspaceStub(db, workspace.id);
		const steps = sampleSteps({
			userIds: Object.fromEntries(SAMPLE_PEOPLE.map(([key]) => [key, people[key].id])) as Record<
				PersonKey,
				string
			>,
			agentId: agent.id,
			newId: () => crypto.randomUUID(),
		});
		// Two calls, not one a step: the workspace may be in a jurisdiction an ocean away, and its
		// hundreds of steps took twenty seconds from there. Cycle ids are the Durable Object's to
		// make, so the steps from the first that needs one wait for the first call's. The agent's
		// example starts in the first call and finishes in the second, so its history has two times.
		const split = steps.findIndex((step) => step.needsCycle);
		const before = split === -1 ? steps : steps.slice(0, split);
		const after = split === -1 ? [] : steps.slice(split);
		const apply = async (part: SampleStep[], offset: number) => {
			const results = await stub.mutateMany(
				"demo-sandbox",
				part.map(({ by, mutation }) => ({
					member: members[by],
					mutationId: crypto.randomUUID(),
					body: mutation,
				})),
			);
			const last = results.at(-1);
			if (results.length === part.length && last?.ok !== false) return;
			const index = results.length - 1;
			throw new Error(
				`Demo seeding failed at step ${offset + index + 1} of ${steps.length} (${part[index]?.mutation.name}): ${last?.ok === false ? `${last.reason}: ${last.message}` : "no result"}`,
			);
		};
		await apply(before, 0);
		if (after.length > 0) {
			const cycleId = currentCycleId(await stub.directory());
			await apply(
				after.map((step) => withCycle(step, cycleId)),
				before.length,
			);
		}

		return { slug };
	} catch (error) {
		// A half-built sandbox is worse than none. Take it all back: the visitor's new session goes
		// with their account, and the page shows the error instead of an empty workspace.
		await discardSandbox(user.id, workspaceId).catch((cleanup: unknown) =>
			console.error("demo: could not discard a failed sandbox", cleanup),
		);
		throw error;
	}
}

async function discardSandbox(userId: string, workspaceId: string | undefined) {
	if (workspaceId) {
		await destroyWorkspace(db, workspaceId);
		await db.delete(schema.organization).where(eq(schema.organization.id, workspaceId));
		// Its sample agent, if it got that far, belonged to it alone.
		await deleteOrphanedAgents(db);
	}
	await db.delete(schema.user).where(eq(schema.user.id, userId));
}

/**
 * The sample's agent, as a member of this sandbox alone, since an agent belongs to one workspace.
 * It is made as the agent members plugin makes one (`createAgent` in `auth/agents.ts`): a user
 * under the agents' domain, which nobody can sign in under, and an `agent` membership. Unlike
 * there, it gets no key, and a key is the only way to act as an agent: what it wrote in the
 * sample is all it does, unless the visitor, as the sandbox's admin, makes it a key in Settings.
 * It goes with the sandbox: deleting the workspace takes its membership, and
 * `deleteOrphanedAgents` its user.
 */
async function addSampleAgent(workspaceId: string): Promise<MemberProfile> {
	const id = crypto.randomUUID();
	const email = `${id}@${AGENT_EMAIL_DOMAIN}`;
	const now = new Date();
	// Together, so the user never exists without the membership that keeps it.
	await db.batch([
		db.insert(schema.user).values({
			id,
			name: AGENT.name,
			email,
			emailVerified: false,
			image: null,
			createdAt: now,
			updatedAt: now,
		}),
		db.insert(schema.member).values({
			id: crypto.randomUUID(),
			organizationId: workspaceId,
			userId: id,
			role: AGENT_ROLE,
			createdAt: now,
		}),
	]);
	// As the plugin does after it makes an agent: the workspace's object learns of its member.
	await syncMembership(db, workspaceId, id);
	return { id, name: AGENT.name, email, image: null, role: AGENT_ROLE };
}

/**
 * The four sample people as users, created once. They are verified and have no credentials, so
 * nobody can sign in as them; they exist to be members of every sandbox and to author its issues.
 * A database that already has them under other ids, such as a local one `pnpm dev:seed` filled,
 * keeps those: they are looked up by address.
 */
async function ensureSamplePeople(): Promise<Record<PersonKey, MemberProfile>> {
	const now = new Date();
	const people = {} as Record<PersonKey, MemberProfile>;
	for (const [key, person] of SAMPLE_PEOPLE) {
		await db
			.insert(schema.user)
			.values({
				id: samplePersonId(key),
				name: person.name,
				email: person.email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
		const row = await db
			.select({ id: schema.user.id })
			.from(schema.user)
			.where(eq(schema.user.email, person.email))
			.get();
		if (!row) throw new Error(`Sample person ${person.email} is missing`);
		people[key] = {
			id: row.id,
			name: person.name,
			email: person.email,
			image: null,
			role: person.role,
		};
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
