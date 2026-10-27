import type { TestProject } from "vitest/node";
import { unstable_startWorker } from "wrangler";

declare module "vitest" {
	export interface ProvidedContext {
		/** Origin of the test worker. */
		syncUrl: string;
	}
}

export default async function setup(project: TestProject) {
	const worker = await unstable_startWorker({
		config: "test/worker/wrangler.jsonc",
		dev: {
			server: { hostname: "127.0.0.1", port: 0 },
			inspector: false,
			logLevel: "warn",
			watch: false,
		},
	});
	await worker.ready;
	project.provide("syncUrl", (await worker.url).origin);
	return () => worker.dispose();
}
