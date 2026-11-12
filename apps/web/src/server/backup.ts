import { WorkerEntrypoint } from "cloudflare:workers";
import type { BackupRow } from "@gateweave/track-sync-server";
import { asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { createDb, schema } from "./db";
import { workspaceStub } from "./workspaces";

/** How many workspaces a page of `objects` holds. */
const PAGE = 100;

const workspaceId = z.string().min(1).max(200);

/**
 * Gateweave Backup's way in (docs/architecture.md, "Backups"). It lists the workspaces, then reads
 * each one's Durable Object with the SELECTs of a SQLite dump, which the object runs together and
 * rolls back. A named entrypoint has no route: only a Worker in the same account with a service
 * binding to it can call it, so that binding is the access, the way the gateways' checks are for
 * people and agents. Deleted workspaces aren't listed, and a name that isn't a workspace is refused
 * before any object is reached, so a backup never makes an empty one.
 */
export class Backup extends WorkerEntrypoint<Env> {
	/** The workspaces' ids, in order, a page at a time: pass back `cursor` for the next page. */
	async objects(cursor?: string): Promise<{ names: string[]; cursor?: string }> {
		const after = cursor === undefined ? undefined : workspaceId.parse(cursor);
		const rows = await createDb(this.env.DB)
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(after === undefined ? undefined : gt(schema.organization.id, after))
			.orderBy(asc(schema.organization.id))
			.limit(PAGE + 1);
		const names = rows.slice(0, PAGE).map((row) => row.id);
		const last = names[names.length - 1];
		return rows.length > PAGE && last ? { names, cursor: last } : { names };
	}

	/** Runs a backup's reads in one workspace's Durable Object. */
	async read(name: string, statements: string[]): Promise<BackupRow[][]> {
		const id = workspaceId.parse(name);
		const found = await createDb(this.env.DB)
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(eq(schema.organization.id, id))
			.get();
		if (!found) throw new Error("There is no workspace of that name.");
		return workspaceStub(id).backupRead(statements);
	}
}
