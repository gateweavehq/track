import { env } from "cloudflare:workers";
import type { DigestItem, PushNotice } from "@gateweave/track-sync-server";
import { and, desc, eq, gt, inArray, notInArray } from "drizzle-orm";
import { toBase64Url } from "#/lib/push-services";
import { db, getAuth } from "../auth";
import { schema } from "../db";
import { demoEnabled } from "../demo/mode";
import { clip, newsLine } from "../email/templates";
import { type PushTarget, readVapidKey, sendWebPush, type VapidKey } from "./webpush";

/**
 * Push notifications: the inbox news a person wants by email, on the devices they turned push on
 * in, as it happens. The workspace's Durable Object decides what is news and when (sync-server's
 * `takeDuePushes`); this sends it to the browsers in `push_subscription`.
 */

/** A person's devices. More is past any real use, and would let one account fill the table. */
const MAX_DEVICES = 20;
/** Of a burst of news, only the newest is pushed; the inbox has the rest. */
const MAX_ITEMS = 5;
/** A device that stays off longer than this gets the news by email instead. */
const TTL_SECONDS = 24 * 60 * 60;

const encoder = new TextEncoder();

let cached: { setting: string; key: Promise<VapidKey | null> } | undefined;

/** The server's push key, or null where push is off: no `PUSH_VAPID_KEY`, or the public demo. */
export function pushKey(): Promise<VapidKey | null> {
	const setting = env.PUSH_VAPID_KEY;
	if (!setting || demoEnabled()) return Promise.resolve(null);
	if (cached?.setting !== setting) {
		cached = {
			setting,
			key: readVapidKey(setting).catch((error: unknown) => {
				// The message says what is wrong with the setting, never the key.
				console.error("push: off,", error instanceof Error ? error.message : "unreadable key");
				return null;
			}),
		};
	}
	return cached.key;
}

/** The public key browsers subscribe with, or null where push is off. */
export async function pushPublicKey(): Promise<string | null> {
	return (await pushKey())?.publicKey ?? null;
}

/**
 * Saves a browser's subscription for whoever is signed in, tied to this session. A browser that
 * saves again, or for someone else who signed in there, replaces its row. False without a session
 * or where push is off.
 */
export async function savePushDevice(request: Request, device: PushTarget): Promise<boolean> {
	if (!(await pushKey())) return false;
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return false;
	const table = schema.pushSubscription;
	const row = {
		endpoint: device.endpoint,
		userId: session.user.id,
		sessionId: session.session.id,
		p256dh: device.p256dh,
		auth: device.auth,
		savedAt: Date.now(),
	};
	await db.insert(table).values(row).onConflictDoUpdate({ target: table.endpoint, set: row }).run();
	const newest = db
		.select({ endpoint: table.endpoint })
		.from(table)
		.where(eq(table.userId, session.user.id))
		.orderBy(desc(table.savedAt))
		.limit(MAX_DEVICES);
	await db
		.delete(table)
		.where(and(eq(table.userId, session.user.id), notInArray(table.endpoint, newest)))
		.run();
	return true;
}

/** Forgets a browser's subscription, if it is the signed-in person's. */
export async function removePushDevice(request: Request, endpoint: string): Promise<void> {
	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) return;
	const table = schema.pushSubscription;
	await db
		.delete(table)
		.where(and(eq(table.endpoint, endpoint), eq(table.userId, session.user.id)))
		.run();
}

/** What a device shows for one piece of news, and the topic that replaces older news on it. */
export async function pushMessage(
	workspaceId: string,
	slug: string,
	item: DigestItem,
): Promise<{ text: string; topic: string }> {
	// Titles, names and comments are typed by members, and a request's title by anyone who can reach
	// its form or address, so they are kept short and on one line, as in email.
	const quote = item.comment === null ? "" : `\n${clip(item.comment, 200)}`;
	const tag = `${workspaceId}/${item.issue.key}`;
	const text = JSON.stringify({
		title: `${item.issue.key} ${clip(item.issue.title, 120)}`,
		body: `${newsLine(item, item.issue.key)}${quote}`,
		url: `/${encodeURIComponent(slug)}/issue/${item.issue.key}`,
		tag,
	});
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(tag));
	return { text, topic: toBase64Url(new Uint8Array(digest)).slice(0, 32) };
}

/**
 * Pushes a member's news, for the workspace's Durable Object. D1 has the last word on where it
 * goes: only to devices whose session is still live, of someone still in the workspace. A device
 * the push service no longer knows is forgotten.
 */
export async function pushInboxNews(notice: PushNotice): Promise<void> {
	const key = await pushKey();
	if (!key) return;
	const now = Date.now();
	const table = schema.pushSubscription;
	const devices = await db
		.select({
			endpoint: table.endpoint,
			p256dh: table.p256dh,
			auth: table.auth,
			slug: schema.organization.slug,
		})
		.from(table)
		.innerJoin(schema.session, eq(schema.session.id, table.sessionId))
		.innerJoin(
			schema.member,
			and(
				eq(schema.member.userId, table.userId),
				eq(schema.member.organizationId, notice.workspace.id),
			),
		)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.where(and(eq(table.userId, notice.member.id), gt(schema.session.expiresAt, new Date(now))))
		.all();
	const [first] = devices;
	if (!first) return;

	const messages = await Promise.all(
		notice.items
			.slice(0, MAX_ITEMS)
			.map((item) => pushMessage(notice.workspace.id, first.slug, item)),
	);
	// Push services want a way to reach whoever sends: the deployment's address.
	const subject = notice.workspace.origin;
	const gone: string[] = [];
	await Promise.all(
		devices.map(async (device) => {
			for (const message of messages) {
				const outcome = await sendWebPush(device, message.text, {
					key,
					subject,
					topic: message.topic,
					ttl: TTL_SECONDS,
					now,
				}).catch((error: unknown) => {
					// The endpoint is a device's address, so it stays out of the logs.
					console.error("push: not sent,", error instanceof Error ? error.message : "failed");
					return "failed" as const;
				});
				if (outcome === "gone") {
					gone.push(device.endpoint);
					return;
				}
			}
		}),
	);
	if (gone.length > 0) await db.delete(table).where(inArray(table.endpoint, gone)).run();
}
