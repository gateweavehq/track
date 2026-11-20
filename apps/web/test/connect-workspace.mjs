// Loaded only by the connection tests. The gateway still reaches the real SQLite object.
// Pausing an RPC on either side of the write lets the test run another gateway or the cron.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import worker, { WorkspaceDO as Workspace } from "./index.js";

export { Backup, RateLimiter } from "./index.js";

// A sweep may be on a faster clock than an Allow paused in another request.
const time = new AsyncLocalStorage();
const clock = Date.now;
let sweepClockOffset = 0;
Date.now = () => {
	const now = time.getStore();
	return typeof now === "object" ? now.start + sweepClockOffset : (now ?? clock());
};

// Hold the workspace existence check that precedes a cleanup's destructive steps.
const statements = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
const raw = statements.raw;
statements.raw = async function (...args) {
	const rows = await raw.apply(this, args);
	if (
		time.getStore()?.start &&
		this.statement === 'select "id" from "organization" where "organization"."id" = ?' &&
		rows.length
	) {
		await env.connectBoundary.fetch("https://test/after-workspace-check", { method: "POST" });
	}
	return rows;
};

export default {
	...worker,
	fetch(request, ...args) {
		if (new URL(request.url).pathname === "/test-sweep-clock") {
			sweepClockOffset = Number(request.headers.get("test-now"));
			return new Response();
		}
		const now = request.headers.get("test-now");
		return time.run(now ? Number(now) : undefined, () => worker.fetch(request, ...args));
	},
	scheduled(event, ...args) {
		return time.run({ start: Number(event.scheduledTime) }, () => worker.scheduled(event, ...args));
	},
};

export class WorkspaceDO extends Workspace {
	setObjectTime(now) {
		this.objectTime = now;
	}

	sourceEvent(...args) {
		return time.run(this.objectTime, () => super.sourceEvent(...args));
	}

	sourcesForAdmin(...args) {
		return time.run(this.objectTime, () => super.sourcesForAdmin(...args));
	}

	async boundary(step, id) {
		const response = await this.env.connectBoundary.fetch("https://test/" + step, {
			method: "POST",
			body: id,
		});
		if (!response.ok) throw Error("Interrupted by the connection test");
	}

	async manageSource(member, command) {
		await this.boundary("before-" + command.kind, command.id);
		const result = await time.run(this.objectTime, () => super.manageSource(member, command));
		if (result.ok) await this.boundary("after-" + command.kind, result.value.id);
		return result;
	}

	async removeConnectedSource(id, ...args) {
		await this.boundary("before-seal", id);
		const result = await time.run(this.objectTime, () => super.removeConnectedSource(id, ...args));
		await this.boundary("after-" + result, id);
		return result;
	}

	async removeMember(id) {
		await this.boundary("before-removeMember", id);
		return super.removeMember(id);
	}

	async removeConnectedWebhooksOf(id) {
		await this.boundary("before-removeConnectedWebhooksOf", id);
		return super.removeConnectedWebhooksOf(id);
	}

	async releaseConnectedSource(id, ...args) {
		await this.boundary("before-release", id);
		return time.run(this.objectTime, () => super.releaseConnectedSource(id, ...args));
	}

	async finishConnectedSourceRemoval(id, ...args) {
		await this.boundary("before-finish", id);
		return time.run(this.objectTime, () => super.finishConnectedSourceRemoval(id, ...args));
	}
}
