// Features a server can turn on for some workspaces before everyone gets them. This list is the
// only place a flag's key and default live: the server asks its flag store for these and nothing
// else, and a server with no flag store (any self-hosted copy, unless it adds one) serves every
// default. A flag is meant to go: once its feature is on for everyone, take the flag out and
// keep the feature. docs/architecture.md has the rest.

export const FLAGS = {
	/** How many open issues are assigned to you, beside "My issues" in the sidebar. */
	"my-issues-count": false,
} as const satisfies Record<string, boolean>;

export type FlagKey = keyof typeof FLAGS;

/**
 * The flags that differ from their default for one workspace. Defaults are left out, so a
 * workspace with nothing turned on carries nothing, and a flag removed from the list above
 * stops mattering on devices that still remember it.
 */
export type FlagValues = Partial<Record<FlagKey, boolean>>;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

/** A flag's value for a workspace: what the server said, or the default. */
export function flagValue(values: FlagValues | undefined, key: FlagKey): boolean {
	const value = values?.[key];
	return typeof value === "boolean" ? value : FLAGS[key];
}
