import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { isPushEndpoint } from "./push-services";

// A browser's push subscription, saved for the signed-in person. Server code is imported inside
// the handlers, so that it stays out of the browser's bundle.

const endpoint = z
	.string()
	.max(1024)
	.refine(isPushEndpoint, "This server sends push only to browsers' push services");

const subscription = z.object({
	endpoint,
	// A P-256 public key, uncompressed, and a 16-byte secret, in base64url.
	keys: z.object({
		p256dh: z.string().regex(/^[\w-]{87}$/),
		auth: z.string().regex(/^[\w-]{22}$/),
	}),
});

/** The key browsers subscribe with, or null where this server sends no push. */
export const getPushKey = createServerFn({ method: "GET" }).handler(async () => {
	const { pushPublicKey } = await import("#/server/push");
	return pushPublicKey();
});

/** Saves this browser's subscription, tied to this session. False without one, or push off. */
export const savePushSubscription = createServerFn({ method: "POST" })
	.validator(subscription)
	.handler(async ({ data }) => {
		const { savePushDevice } = await import("#/server/push");
		return savePushDevice(getRequest(), {
			endpoint: data.endpoint,
			p256dh: data.keys.p256dh,
			auth: data.keys.auth,
		});
	});

export const removePushSubscription = createServerFn({ method: "POST" })
	.validator(z.object({ endpoint: z.string().max(1024) }))
	.handler(async ({ data }) => {
		const { removePushDevice } = await import("#/server/push");
		await removePushDevice(getRequest(), data.endpoint);
	});
