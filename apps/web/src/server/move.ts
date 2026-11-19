import { env } from "cloudflare:workers";
import { moveWorkspace } from "@gateweave/track-sync-server";
import { and, asc, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
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

const MOVED_COPY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// One query and two subrequests per copy leave room under 50 with three small moves
// at about 12 each, their selection query, and the rest of the daily run.
const FORGETS_PER_RUN = 3;

/**
 * Moves workspaces whose Durable Object is outside the deployment's jurisdiction into it, the
 * oldest first, a few each run. Each is paused for the seconds its copy takes. The old object is
 * sealed at once, and the daily run deletes its copy once the move is at least a week old.
 */
export async function moveWorkspaces(db: Database): Promise<void> {
	const target = configuredJurisdiction();
	// Forgetting first: a large move can use up the run's subrequests, and a copy waiting to be
	// deleted matters more than a move, which the next run makes as well.
	await forgetMovedCopies(db);
	if (target) await moveIntoJurisdiction(db, target);
}

async function moveIntoJurisdiction(
	db: Database,
	target: DurableObjectJurisdiction,
): Promise<void> {
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
			and(
				// Each row tracks one sealed copy. Keep its location until that copy is deleted.
				isNull(schema.workspaceLocation.movedFrom),
				or(
					isNull(schema.workspaceLocation.jurisdiction),
					ne(schema.workspaceLocation.jurisdiction, target),
				),
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

async function forgetMovedCopies(db: Database): Promise<void> {
	const location = schema.workspaceLocation;
	const copies = await db
		.select()
		.from(location)
		.where(
			and(
				isNotNull(location.movedFrom),
				lte(location.movedAt, Date.now() - MOVED_COPY_DAYS * DAY_MS),
			),
		)
		// In no fixed order, so a copy that keeps failing can't hold a place in every run and keep
		// the others waiting behind it.
		.orderBy(sql`random()`)
		.limit(FORGETS_PER_RUN)
		.all();
	for (const { workspaceId, jurisdiction, movedFrom, movedAt } of copies) {
		if (movedFrom === null || movedAt === null) continue;
		if (movedFrom === jurisdiction) {
			console.error(`move: workspace ${workspaceId}'s old copy points to its current jurisdiction`);
			continue;
		}
		try {
			await objectsIn(env.WORKSPACE, movedFrom).getByName(workspaceId).moveForget();
			await db
				.update(location)
				.set({ movedFrom: null })
				.where(
					and(
						eq(location.workspaceId, workspaceId),
						eq(location.jurisdiction, jurisdiction),
						eq(location.movedFrom, movedFrom),
						eq(location.movedAt, movedAt),
					),
				)
				.run();
		} catch (error) {
			console.error(`move: workspace ${workspaceId}'s old copy wasn't forgotten`, error);
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
