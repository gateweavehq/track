import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { destroyWorkspace } from "./workspaces";

// "Deleting a workspace" in docs/architecture.md.

/**
 * How many deletions one daily run finishes. Each takes about seven subrequests (its rows, the
 * object, an old copy, a page of files), and a Worker on the Free plan makes 50 a run, shared with
 * the rest of its work. Notes are rare: the request finishes nearly every deletion itself. One
 * that fails goes to the back, so the others still get a turn.
 */
const DELETIONS_PER_RUN = 2;

const { workspaceDeletion, organization } = schema;

// The note itself is written with the deletion, by `beforeDeleteOrganization` in auth/config.ts.

/**
 * Deletes what a deleted workspace left: its object, an old copy and its files, then its note.
 * One that fails stays noted, goes to the back, and the daily run tries it again. A workspace whose
 * row is still there is never touched: its row is what says it exists, so a note that says
 * otherwise is wrong, and goes.
 */
export async function finishWorkspaceDeletion(db: Database, workspaceId: string): Promise<void> {
	const live = await db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, workspaceId))
		.get();
	if (live) {
		await db.delete(workspaceDeletion).where(eq(workspaceDeletion.workspaceId, workspaceId)).run();
		throw new Error("the workspace is still there, so its note went and nothing was deleted");
	}
	try {
		await destroyWorkspace(db, workspaceId);
	} catch (error) {
		// The failure that matters is the one above, even when this can't be noted either.
		await db
			.update(workspaceDeletion)
			.set({ lastTriedAt: Date.now() })
			.where(eq(workspaceDeletion.workspaceId, workspaceId))
			.run()
			.catch(() => {});
		throw error;
	}
}

/**
 * From the daily run: notes the deletions nothing noted, then finishes a few. A location row whose
 * workspace is gone is one: deleted before these notes, deleted by hand, or noted by a move that
 * ran into the deletion. Location rows are written only for workspaces that exist. Only ids reach
 * the log.
 */
export async function retryWorkspaceDeletions(db: Database): Promise<void> {
	try {
		await db
			.insert(workspaceDeletion)
			.select(sql`
				SELECT workspace_id, ${Date.now()}, NULL FROM workspace_location
				WHERE NOT EXISTS (SELECT 1 FROM organization WHERE organization.id = workspace_location.workspace_id)
			`)
			.onConflictDoNothing()
			.run();
		const due = await db
			.select({ workspaceId: workspaceDeletion.workspaceId })
			.from(workspaceDeletion)
			.orderBy(asc(workspaceDeletion.lastTriedAt), asc(workspaceDeletion.deletedAt))
			.limit(DELETIONS_PER_RUN)
			.all();
		for (const { workspaceId } of due) {
			try {
				await finishWorkspaceDeletion(db, workspaceId);
				console.log(`deletion: workspace ${workspaceId} is deleted`);
			} catch (error) {
				console.error(`deletion: workspace ${workspaceId} will be tried again`, error);
			}
		}
	} catch (error) {
		// The rest of the daily run goes on; the notes wait for the next.
		console.error("deletion: the daily run couldn't read the deletions", error);
	}
}
