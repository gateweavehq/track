// Makes the key a Track server signs push notifications with (PUSH_VAPID_KEY): a new P-256
// private key as a JWK, on standard output. Pipe it straight into the secret, so it is never shown:
//
//   node apps/web/scripts/push-key.mjs | pnpm wrangler secret put PUSH_VAPID_KEY
//
// See "Push notifications" in docs/self-hosting.md.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.stdout.write(JSON.stringify(privateKey.export({ format: "jwk" })));
