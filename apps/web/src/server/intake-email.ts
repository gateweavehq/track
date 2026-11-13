import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import PostalMime, { type Attachment } from "postal-mime";
import {
	attachmentMarkdown,
	attachmentName,
	attachmentPath,
	MAX_FILE_BYTES,
} from "#/lib/attachments";
import {
	isAutomated,
	parseIntakeAddress,
	replyFromEmail,
	requestFromEmail,
} from "#/lib/intake-email";
import { db } from "./auth";
import { schema } from "./db";
import { demoEnabled } from "./demo/mode";
import { releaseFileStorage, reserveFileStorage } from "./file-quota";
import { mediaType } from "./files";
import { limitEmailedReplies, limitEmailedRequests } from "./rate-limit";
import { findWorkspaceStub } from "./workspaces";

/** The largest email read where attachments are not kept: its text is all that is. */
export const MAX_INTAKE_EMAIL = 1024 * 1024;

/** The largest email read where attachments are kept, in the bucket of attached files. */
export const MAX_INTAKE_EMAIL_WITH_FILES = 10 * 1024 * 1024;

/** The most attachments one email keeps; the description says how many more were left out. */
export const MAX_INTAKE_ATTACHMENTS = 10;

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
 * becomes a request in its intake. A reply to the decision on a request goes to the request's own
 * address, with a longer key, and becomes a comment on it.
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
	const bucket = env.FILES;
	const max = bucket ? MAX_INTAKE_EMAIL_WITH_FILES : MAX_INTAKE_EMAIL;
	if (message.rawSize > max) return message.setReject("The message is too large");

	// Mail systems may change the case of an address, and a workspace's id has capitals.
	const workspace = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(sql`lower(${schema.organization.id}) = ${address.workspaceId}`)
		.get();
	if (!workspace) return message.setReject("No such address");
	const stub = await findWorkspaceStub(db, workspace.id);
	const sender = message.from.trim().toLowerCase();
	if (address.kind === "reply") return fileReply(message, stub, workspace.id, address.key, sender);
	// The key is checked before anything is counted, so mail to made-up addresses costs no one's
	// allowance and leaves no record behind.
	if (!(await stub.intakeEmail(address.key))) return message.setReject("No such address");
	if (!(await limitEmailedRequests(sender, address.key))) {
		return message.setReject("Too many requests from this sender; try again later");
	}

	const email = await PostalMime.parse(message.raw, { maxPartCount: 200 });
	const from = email.from && "address" in email.from ? email.from.address : undefined;
	const kept = bucket ? await keepAttachments(bucket, workspace.id, email.attachments) : [];
	const { title, description } = requestFromEmail(
		email,
		from || sender,
		kept.map((file) => file.markdown),
	);
	const replyTo = (from || sender).trim().toLowerCase();
	const filed = await stub.fileRequest({
		via: "email",
		// The address it came from hears of the decision. Anyone can forge it, but all they get
		// is a short note, written by the team, sent to an address that wrote to it.
		requester:
			replyTo.length <= 254 && replyTo.includes("@")
				? { workspaceId: workspace.id, email: replyTo }
				: null,
		key: address.key,
		title,
		description,
		sortOrder: generateKeyBetween(await stub.lastSortOrder(), null),
	});
	if (filed) return;
	// The address was turned off a moment ago: nothing links the files, so they go too.
	if (bucket) await dropAttachments(bucket, workspace.id, kept);
	message.setReject("No such address");
}

/**
 * Files a requester's reply to the decision on their request as a comment on it. Only the address
 * the decision went to may reply, and each request takes only so many. The key is checked before
 * the message is read, so mail to a made-up address costs no parsing, and the sender once it is,
 * before anything is counted or stored. A reply that fails either check is refused as mail to a
 * missing address is. A reply with nothing of its own, once quotes are taken out, files nothing.
 */
async function fileReply(
	message: ForwardableEmailMessage,
	stub: Awaited<ReturnType<typeof findWorkspaceStub>>,
	workspaceId: string,
	key: string,
	sender: string,
): Promise<void> {
	// Only a key of a reply key's form gets here (parseIntakeAddress), and only one a request has
	// gets past this.
	const target = await stub.replyTarget(key);
	if (!target) return message.setReject("No such address");
	const email = await PostalMime.parse(message.raw, { maxPartCount: 200 });
	const from = ((email.from && "address" in email.from ? email.from.address : undefined) || sender)
		.trim()
		.toLowerCase();
	if (from !== target.email) return message.setReject("No such address");
	if (!(await limitEmailedReplies(key))) {
		return message.setReject("Too many replies to this request; try again later");
	}
	const text = replyFromEmail(email);
	const bucket = env.FILES;
	const kept = bucket ? await keepAttachments(bucket, workspaceId, email.attachments) : [];
	const body = [text, ...kept.map((file) => file.markdown)].filter(Boolean).join("\n\n");
	if (!body) return;
	if (await stub.fileReply({ key, from, body })) return;
	// The request was deleted a moment ago: nothing links the files, so they go too.
	if (bucket) await dropAttachments(bucket, workspaceId, kept);
	message.setReject("No such address");
}

interface KeptFile {
	key: string;
	size: number;
	markdown: string;
}

/** Deletes kept files nothing links after all, and gives their space back. */
async function dropAttachments(bucket: R2Bucket, workspaceId: string, kept: KeptFile[]) {
	if (kept.length === 0) return;
	await bucket.delete(kept.map((file) => file.key));
	await releaseFileStorage(
		workspaceId,
		kept.reduce((total, file) => total + file.size, 0),
	);
}

/**
 * Stores an email's attachments in the bucket of attached files, as the file gateway stores what
 * members attach, so the request links them and members open them as any other attachment. Up to
 * MAX_INTAKE_ATTACHMENTS, each within the gateway's size limit; empty ones are skipped.
 */
async function keepAttachments(
	bucket: R2Bucket,
	workspaceId: string,
	attachments: Attachment[],
): Promise<KeptFile[]> {
	const kept: KeptFile[] = [];
	for (const attachment of attachments) {
		if (kept.length >= MAX_INTAKE_ATTACHMENTS) break;
		const content = attachment.content;
		const size = typeof content === "string" ? content.length : content.byteLength;
		if (size === 0 || size > MAX_FILE_BYTES) continue;
		const fileId = crypto.randomUUID();
		const name = attachmentName(attachment.filename ?? "attachment");
		const type = mediaType(attachment.mimeType);
		const key = `${workspaceId}/${fileId}/${name}`;
		// Past the workspace's quota, the request still comes in, without the files that do not fit.
		if (!(await reserveFileStorage(bucket, workspaceId, size))) continue;
		try {
			await bucket.put(key, content, {
				httpMetadata: { contentType: type },
				customMetadata: { uploadedBy: "email" },
			});
		} catch (cause) {
			await releaseFileStorage(workspaceId, size);
			throw cause;
		}
		kept.push({
			key,
			size,
			markdown: attachmentMarkdown(name, attachmentPath(workspaceId, fileId, name), type),
		});
	}
	return kept;
}
