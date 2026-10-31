import { z } from "zod";
import type { InboxEvent } from "./domain";

/** The kinds of news that reach an inbox, one per {@link InboxEvent} type. */
export const NOTIFICATION_KINDS = [
	"assigned",
	"unassigned",
	"comment",
	"status",
	"proposal",
] as const satisfies readonly InboxEvent["type"][];

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Where a kind of news goes: nowhere, to the inbox, or to the inbox and, when it stays unread,
 * to email.
 */
export const NOTIFICATION_LEVELS = ["off", "inbox", "email"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** A person's choices in one workspace. Private to them. */
export type NotificationSettings = Record<NotificationKind, NotificationLevel>;

/** What a person gets until they choose: email for what asks something of them. */
export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
	assigned: "email",
	unassigned: "inbox",
	comment: "email",
	status: "inbox",
	proposal: "inbox",
};

/** A change to a person's settings. Kinds left out stay as they are. */
export const notificationSettingsPatch = z.partialRecord(
	z.enum(NOTIFICATION_KINDS),
	z.enum(NOTIFICATION_LEVELS),
);

export type NotificationSettingsPatch = z.infer<typeof notificationSettingsPatch>;

/** How long news waits, unread, before it is emailed. Reading it first keeps it out of email. */
export const EMAIL_DELAY_MS = 10 * 60 * 1000;

/** The shortest time between two emails to one person from one workspace. */
export const EMAIL_INTERVAL_MS = 60 * 60 * 1000;
