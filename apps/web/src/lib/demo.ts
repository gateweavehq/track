import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * Opens a private sandbox for the visitor and signs them in, on the public demo only: anywhere
 * else it fails before creating anything. Returns the workspace slug.
 */
export const startDemo = createServerFn({ method: "POST" }).handler(async () => {
	const { startDemoSandbox } = await import("#/server/demo/start");
	return startDemoSandbox(getRequestHeaders());
});
