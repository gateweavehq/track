import { env } from "cloudflare:workers";
import { moveWorkspace } from "@gateweave/track-sync-server";
import { asc, eq, isNull, ne, or } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { configuredJurisdiction, objectsIn } from "./jurisdiction";
import { type WorkspaceRef, workspaceStub } from "./workspaces";

// "Where a workspace lives" in docs/architecture.md.

/**
 * How many workspaces one daily run moves. A small workspace takes about a dozen subrequests, of
 * the 50 a Worker on the Free plan makes, which the run shares with the rest of its work.
 */
const MOVES_PER_RUN = 3;

/**
 * Moves workspaces whose Durable Object is outside the deployment's jurisdiction into it, the
 * oldest first, a few each run. Each is paused for the seconds its copy takes. The old object
 * is sealed and keeps what the workspace held, until the workspace is deleted.
 */
export async function moveWorkspaces(db: Database): Promise<void> {
	const target = configuredJurisdiction();
	if (!target) return;
	const elsewhere = await db
		.select({
			workspaceId: schema.organization.id,
			jurisdiction: schema.workspaceLocation.jurisdiction,
		})
		.from(schema.organization)
		.leftJoin(
			schema.workspaceLocation,
			eq(schema.workspaceLocation.workspaceId, schema.organization.id),
		)
		.where(
			or(
				isNull(schema.workspaceLocation.jurisdiction),
				ne(schema.workspaceLocation.jurisdiction, target),
			),
		)
		.orderBy(asc(schema.organization.createdAt))
		.limit(MOVES_PER_RUN)
		.all();
	for (const workspace of elsewhere) {
		const started = Date.now();
		try {
			const report = await moveWorkspace(
				workspaceStub(workspace),
				objectsIn(env.WORKSPACE, target).getByName(workspace.workspaceId),
				{ label: target, record: () => recordMove(db, workspace, target) },
			);
			const what = report.finished
				? "finishing a move that had copied it"
				: `${report.rows} rows in ${report.tables} tables, version ${report.version}`;
			console.log(
				`move: workspace ${workspace.workspaceId} is in ${target} now, ${what}, in ${Date.now() - started} ms`,
			);
		} catch (error) {
			console.error(`move: workspace ${workspace.workspaceId} didn't move to ${target}`, error);
		}
	}
}

async function recordMove(db: Database, from: WorkspaceRef, to: string): Promise<void> {
	const moved = { jurisdiction: to, movedFrom: from.jurisdiction ?? "", movedAt: Date.now() };
	await db
		.insert(schema.workspaceLocation)
		.values({ workspaceId: from.workspaceId, ...moved })
		.onConflictDoUpdate({ target: schema.workspaceLocation.workspaceId, set: moved })
		.run();
}
