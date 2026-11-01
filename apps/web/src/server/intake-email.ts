import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import PostalMime from "postal-mime";
import { isAutomated, parseIntakeAddress, requestFromEmail } from "#/lib/intake-email";
import { db } from "./auth";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { limitEmailedRequests } from "./rate-limit";
import { workspaceStub } from "./workspaces";

/** The largest email read. Its text is all that is kept, and attachments are left out. */
export const MAX_INTAKE_EMAIL = 1024 * 1024;

/**
 * The domain of teams' intake addresses, or null when they take no email here: no domain routes
 * to Track, or this is the public demo.
 */
export function intakeEmailDomain(): string | null {
	return env.INTAKE_EMAIL_DOMAIN && !demoEnabled() ? env.INTAKE_EMAIL_DOMAIN : null;
}

/**
 * Email that Cloudflare Email Routing sends to the Worker, from a catch-all rule on
 * `INTAKE_EMAIL_DOMAIN`. Mail to a team's intake address, `<workspace id>.<key>@<domain>`,
 * becomes a request in its intake.
 *
 * Anyone can send email, so the key in the address is what admits it, each sender and each
 * team's address take only so many, and mail a machine sent on its own is dropped without a
 * bounce. Mail to any other address is refused, so the sender hears it went nowhere.
 */
export async function handleIntakeEmail(message: ForwardableEmailMessage): Promise<void> {
	const domain = env.INTAKE_EMAIL_DOMAIN;
	if (!domain || demoEnabled()) return message.setReject("This address takes no email");
	const address = parseIntakeAddress(message.to, domain);
	if (!address) return message.setReject("No such address");
	// A bounce or an out-of-office reply would only come back; it is dropped instead.
	if (isAutomated(message.headers)) return;
	if (message.rawSize > MAX_INTAKE_EMAIL) return message.setReject("The message is too large");

	// Mail systems may change the case of an address, and a workspace's id has capitals.
	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(sql`lower(${schema.organization.id}) = ${address.workspaceId}`)
		.get();
	if (!workspace) return message.setReject("No such address");
	// The key is checked before anything is counted, so mail to made-up addresses costs no one's
	// allowance and leaves no record behind.
	const stub = workspaceStub(workspace.id);
	if (!(await stub.intakeEmail(address.key))) return message.setReject("No such address");
	const sender = message.from.trim().toLowerCase();
	if (!(await limitEmailedRequests(sender, address.key))) {
		return message.setReject("Too many requests from this sender; try again later");
	}

	const email = await PostalMime.parse(message.raw, { maxPartCount: 200 });
	const from = email.from && "address" in email.from ? email.from.address : undefined;
	const { title, description } = requestFromEmail(email, from || sender);
	const filed = await stub.fileRequest({
		via: "email",
		key: address.key,
		title,
		description,
		sortOrder: generateKeyBetween(await stub.lastSortOrder(), null),
	});
	if (!filed) message.setReject("No such address");
}
