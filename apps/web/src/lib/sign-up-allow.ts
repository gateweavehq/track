import { z } from "zod";

// The owner's list of who may make an account while sign-up is closed ("Who runs this server" in
// docs/architecture.md). Both the page and the server read an entry through here.

export const MAX_ALLOW_ENTRIES = 5000;
export const MAX_ALLOW_NOTE = 200;

const ENTRY_PROBLEM =
	"Enter an email address, or a domain with an @ in front, such as @example.com.";

/**
 * An address in full, or a domain with a leading `@` that covers addresses at exactly that domain and
 * not its subdomains. Trimmed and lowercased, which is how the server compares an address.
 */
export const allowEntry = z
	.string()
	.trim()
	.toLowerCase()
	.max(254, ENTRY_PROBLEM)
	.refine(
		(entry) =>
			entry.startsWith("@")
				? // A domain is valid when an address at it is, which is how sign-up reads one.
					entry.length > 1 && z.email().safeParse(`x${entry}`).success
				: z.email().safeParse(entry).success,
		ENTRY_PROBLEM,
	);

/** The owner's own words, such as "from the waitlist". Empty means none. */
export const allowNote = z
	.string()
	.trim()
	.max(MAX_ALLOW_NOTE, `Keep the note to ${MAX_ALLOW_NOTE} characters.`)
	.transform((note) => note || null);

export function isDomainEntry(entry: string): boolean {
	return entry.startsWith("@");
}
