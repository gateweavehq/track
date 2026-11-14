import { env } from "cloudflare:workers";
import type { FlagValues } from "#/lib/flags";
import { evaluateFlags } from "./evaluate";

/**
 * This deployment's flags for a workspace, from its `FLAGS` binding. The binding is optional:
 * without it nothing is asked and every flag is its default. Its type comes from `wrangler types`,
 * which makes it optional because only one environment in wrangler.jsonc has it.
 */
export function workspaceFlags(workspaceId: string): Promise<FlagValues | undefined> {
	return evaluateFlags(env.FLAGS, workspaceId);
}
