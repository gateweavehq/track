import { env } from "cloudflare:workers";
import { createMailer } from "./mailer";

/** Undefined when email is not configured. */
export const mailer = createMailer(env.EMAIL, env.EMAIL_FROM || undefined);
