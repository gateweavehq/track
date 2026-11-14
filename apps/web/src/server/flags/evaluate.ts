import { FLAG_KEYS, FLAGS, type FlagValues } from "#/lib/flags";

/** The part of Cloudflare's Flagship binding this uses. */
export type FlagStore = Pick<Flagship, "getBooleanValue">;

/**
 * The flags that differ from their default for a workspace, or undefined when none do, which is
 * also the answer without a flag store.
 *
 * A flag is decided per workspace, so everyone in one sees the same thing: the workspace's id is
 * the targeting key, which is what percentage rollouts are counted by. The store keeps what it is
 * sent for weeks, where anyone who may read the account's analytics can see it, so it gets that
 * id and nothing else: no person, no name, no address, no slug someone chose.
 *
 * A store that fails must not keep a workspace from opening: that flag is its default.
 */
export async function evaluateFlags(
	store: FlagStore | undefined,
	workspaceId: string,
): Promise<FlagValues | undefined> {
	if (!store) return undefined;
	const context = { targetingKey: workspaceId, workspace: workspaceId };
	const values: FlagValues = {};
	await Promise.all(
		FLAG_KEYS.map(async (key) => {
			try {
				const value = await store.getBooleanValue(key, FLAGS[key], context);
				if (value !== FLAGS[key]) values[key] = value;
			} catch {
				// The default, which is what leaving it out means.
			}
		}),
	);
	return Object.keys(values).length > 0 ? values : undefined;
}
