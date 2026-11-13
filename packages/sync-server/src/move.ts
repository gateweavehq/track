import { currentVersion } from "./log";
import type { Db } from "./state";

/**
 * Moving a workspace to another Durable Object, such as the same name in one of Cloudflare's
 * jurisdictions (docs/architecture.md, "Where a workspace lives"). Cloudflare doesn't move an object,
 * and the same name in another jurisdiction is another, empty one, so the app copies the workspace
 * across ({@link moveWorkspace}):
 *
 * 1. The old object freezes: triggers refuse every write to its tables, its sockets close and its
 *    alarm waits. A freeze lapses after {@link MOVE_FREEZE_MS}, so a move that dies half way
 *    leaves the workspace where it was, working again by then. It holds through a restart: the
 *    object waits idle while its rows are copied, may be evicted, and must not take writes the copy
 *    has missed when it wakes.
 * 2. The new object is emptied and migrated, then takes the old one's rows a page at a time: tables
 *    others refer to first, and rowids too, since history is read in rowid order.
 * 3. Both count their rows and hash them, each value as SQLite quotes it, and the two must agree.
 * 4. The old object seals: it refuses everything from then on and keeps its data until it is
 *    destroyed. Then the new one starts its alarm, and the app records where the workspace is.
 *
 * Versions travel with the oplog, so replicas carry on from where they were.
 */

/** How long a freeze holds. A move takes seconds; this only bounds one that died half way. */
export const MOVE_FREEZE_MS = 10 * 60 * 1000;

/** About how many characters a page of rows carries: well under what one RPC call can take. */
const PAGE_CHARS = 4_000_000;

/** Why a write fails in a frozen or sealed workspace, as its triggers raise it. */
export const MOVING_MESSAGE = "This workspace is moving to another place. Try again in a minute.";

// Where a move stands, in the object's key-value storage, which the copy leaves out: only SQL
// tables travel, so none of this reaches the other object.
const FREEZE = "move.freeze";
const SEALED = "move.sealed";
const IMPORT = "move.import";

const BLOCK = "_move_block_";

interface Freeze {
	token: string;
	until: number;
	/** Where the workspace is going, as the app names it. */
	to: string;
}

interface Sealed {
	to: string;
	at: number;
}

interface Import {
	token: string;
}

export interface MoveTable {
	name: string;
	/** Its columns, in order, without hidden ones. Every row carries its rowid first. */
	columns: string[];
	rows: number;
}

/** What a frozen workspace holds, which the copy has to match. */
export interface MoveManifest {
	tables: MoveTable[];
	version: number;
}

export type MoveOut =
	| { frozen: true; manifest: MoveManifest }
	/** It moved before: sealed, holding the data it had then, at this version. */
	| { frozen: false; sealedTo: string; version: number };

/** Where the next page starts: a table, by its place in the manifest, and the rowid read last. */
export interface MoveCursor {
	table: number;
	after: number | null;
}

export interface MoveRows {
	table: string;
	/** Each row's rowid, then its columns' values, in the manifest's order. */
	rows: SqlStorageValue[][];
}

export interface MovePage {
	tables: MoveRows[];
	next: MoveCursor | null;
}

/** Where a move leaves an object, as it starts up. */
export type MoveState = "sealed" | "importing" | "frozen" | null;

interface CopiedTable {
	name: string;
	virtual: boolean;
	columns: string[];
}

/** The tables a move copies: the workspace's own, and its full-text indexes, by their content. */
function copiedTables(storage: DurableObjectStorage): CopiedTable[] {
	const list = storage.sql
		.exec<{ name: string; type: string }>("PRAGMA table_list")
		.toArray()
		.filter(
			({ name, type }) =>
				(type === "table" || type === "virtual") &&
				!name.startsWith("sqlite_") &&
				!name.startsWith("_cf_") &&
				!name.startsWith("__cf_") &&
				name !== "__drizzle_migrations",
		);
	const tables = list.map(({ name, type }) => ({
		name,
		virtual: type === "virtual",
		columns: storage.sql
			.exec<{ name: string; hidden: number }>(`PRAGMA table_xinfo(${quoteName(name)})`)
			.toArray()
			.filter((column) => column.hidden === 0)
			.map((column) => column.name),
	}));
	return parentsFirst(storage, tables);
}

/**
 * Orders tables so that each comes after the tables it refers to, as rows are written a page at a
 * time and each page's foreign keys are checked when it commits. Then by name, so both objects
 * agree. A table that refers to itself would still fail, if its rows came over in two pages.
 */
function parentsFirst(storage: DurableObjectStorage, tables: CopiedTable[]): CopiedTable[] {
	const names = new Set(tables.map((table) => table.name));
	const parents = new Map(
		tables.map((table) => [
			table.name,
			new Set(
				table.virtual
					? []
					: storage.sql
							.exec<{ table: string }>(`PRAGMA foreign_key_list(${quoteName(table.name)})`)
							.toArray()
							.map((key) => key.table)
							.filter((parent) => parent !== table.name && names.has(parent)),
			),
		]),
	);
	const ordered: CopiedTable[] = [];
	const placed = new Set<string>();
	const waiting = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	while (waiting.length > 0) {
		const index = waiting.findIndex((table) =>
			[...(parents.get(table.name) ?? [])].every((parent) => placed.has(parent)),
		);
		// Tables that refer to each other in a ring: take them in name order.
		const [next] = waiting.splice(index === -1 ? 0 : index, 1);
		if (!next) break;
		ordered.push(next);
		placed.add(next.name);
	}
	return ordered;
}

function quoteName(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function count(storage: DurableObjectStorage, table: string): number {
	return storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${quoteName(table)}`).one().n;
}

function manifestOf(storage: DurableObjectStorage, db: Db): MoveManifest {
	return {
		tables: copiedTables(storage).map(({ name, columns }) => ({
			name,
			columns,
			rows: count(storage, name),
		})),
		version: currentVersion(db),
	};
}

function dropBlocks(storage: DurableObjectStorage): void {
	const triggers = storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB ?",
			`${BLOCK}*`,
		)
		.toArray();
	for (const { name } of triggers) storage.sql.exec(`DROP TRIGGER ${quoteName(name)}`);
}

// The old object.

/**
 * Freezes the workspace for a move to `to`, and says what it holds. A workspace sealed by an
 * earlier move says so instead. The same token freezes it again; another one waits for the first
 * move's freeze to end.
 */
export function freezeForMove(
	storage: DurableObjectStorage,
	db: Db,
	token: string,
	to: string,
	now: number,
): MoveOut {
	const sealed = storage.kv.get<Sealed>(SEALED);
	if (sealed) return { frozen: false, sealedTo: sealed.to, version: currentVersion(db) };
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (freeze && freeze.token !== token && freeze.until > now) {
		throw new Error("Another move of this workspace is under way.");
	}
	storage.transactionSync(() => {
		dropBlocks(storage);
		const message = MOVING_MESSAGE.replaceAll("'", "''");
		for (const table of copiedTables(storage)) {
			if (table.virtual) continue;
			for (const event of ["INSERT", "UPDATE", "DELETE"]) {
				storage.sql.exec(
					`CREATE TRIGGER ${quoteName(`${BLOCK}${table.name}_${event.toLowerCase()}`)}
					BEFORE ${event} ON ${quoteName(table.name)}
					BEGIN SELECT RAISE(ABORT, '${message}'); END`,
				);
			}
		}
		storage.kv.put(FREEZE, { token, until: now + MOVE_FREEZE_MS, to } satisfies Freeze);
	});
	return { frozen: true, manifest: manifestOf(storage, db) };
}

/** When the freeze on the workspace ends, if there is one: it lapses then. */
export function freezeEnds(storage: DurableObjectStorage): number | null {
	return storage.kv.get<Freeze>(FREEZE)?.until ?? null;
}

function checkFreeze(storage: DurableObjectStorage, token: string, now: number): Freeze {
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (!freeze || freeze.token !== token || freeze.until <= now) {
		throw new Error("The move was interrupted: the workspace is no longer frozen for it.");
	}
	return freeze;
}

/** How a move's freeze ended when it gave up: thawed, sealed after all, or none to end. */
export type Thawed = "thawed" | "sealed" | "none";

/** Ends a move's freeze when it gives up, unless the workspace was sealed after all. */
export function thawAfterMove(storage: DurableObjectStorage, token: string): Thawed {
	if (storage.kv.get(SEALED) !== undefined) return "sealed";
	return thaw(storage, token) ? "thawed" : "none";
}

/** Ends a freeze: the move's, given its token, or whichever there is. Writes work again. */
export function thaw(storage: DurableObjectStorage, token?: string): boolean {
	const freeze = storage.kv.get<Freeze>(FREEZE);
	if (!freeze || (token !== undefined && freeze.token !== token)) return false;
	storage.transactionSync(() => {
		dropBlocks(storage);
		storage.kv.delete(FREEZE);
	});
	return true;
}

/**
 * The next page of the frozen workspace's rows, from `cursor` on: whole rows, about `chars` of
 * them, and at least one.
 */
export function readForMove(
	storage: DurableObjectStorage,
	token: string,
	cursor: MoveCursor,
	now: number,
	chars = PAGE_CHARS,
): MovePage {
	checkFreeze(storage, token, now);
	const tables = copiedTables(storage);
	const page: MoveRows[] = [];
	let left = Math.min(Math.max(1, chars), PAGE_CHARS);
	for (let index = cursor.table; index < tables.length; index++) {
		const table = tables[index];
		if (!table) break;
		const after = index === cursor.table ? cursor.after : null;
		const columns = ["rowid", ...table.columns].map(quoteName).join(", ");
		// A number is bound as a real, and a full-text table can drop a rowid constraint that is not
		// an integer (search.ts), hence the cast.
		const where = after === null ? "" : " WHERE rowid > CAST(? AS INTEGER)";
		const query = `SELECT ${columns} FROM ${quoteName(table.name)}${where} ORDER BY rowid`;
		const rows: SqlStorageValue[][] = [];
		let last = after;
		for (const row of storage.sql.exec(query, ...(after === null ? [] : [after])).raw()) {
			rows.push(row);
			last = row[0] as number;
			left -= size(row);
			if (left <= 0) break;
		}
		if (rows.length > 0) page.push({ table: table.name, rows });
		if (left <= 0) return { tables: page, next: { table: index, after: last } };
	}
	return { tables: page, next: null };
}

function size(row: SqlStorageValue[]): number {
	let chars = 0;
	for (const value of row) {
		if (typeof value === "string") chars += value.length + 2;
		else if (value instanceof ArrayBuffer) chars += value.byteLength;
		else chars += 8;
	}
	return chars;
}

/**
 * Seals the workspace once its copy is checked: it refuses everything from then on, and keeps its
 * data until it is destroyed.
 */
export function sealForMove(storage: DurableObjectStorage, token: string, now: number): void {
	const freeze = checkFreeze(storage, token, now);
	storage.transactionSync(() => {
		storage.kv.put(SEALED, { to: freeze.to, at: now } satisfies Sealed);
		storage.kv.delete(FREEZE);
	});
}

// The new object.

/**
 * Whether this object may be emptied for a move into it: it is new, or a move's earlier copy, or
 * a workspace that has since moved away. One holding a live workspace never is, nor one moving out.
 */
export function mayImport(storage: DurableObjectStorage, db: Db): boolean {
	if (storage.kv.get(FREEZE) !== undefined) return false;
	return (
		storage.kv.get(IMPORT) !== undefined ||
		storage.kv.get(SEALED) !== undefined ||
		currentVersion(db) === 0
	);
}

/**
 * Readies an emptied, migrated object for the rows in `manifest`: it must have the same tables and
 * columns, and none of the rows its migrations wrote.
 */
export function beginImport(
	storage: DurableObjectStorage,
	token: string,
	manifest: MoveManifest,
): void {
	const own = new Map(copiedTables(storage).map((table) => [table.name, table]));
	const theirs = manifest.tables.map((table) => table.name);
	const differ = [
		...manifest.tables.filter(
			(table) => own.get(table.name)?.columns.join() !== table.columns.join(),
		),
	].map((table) => table.name);
	differ.push(...[...own.keys()].filter((name) => !theirs.includes(name)));
	if (differ.length > 0) {
		throw new Error(
			`The two objects' tables differ: ${differ.join(", ")}. Deploy one version first.`,
		);
	}
	storage.transactionSync(() => {
		for (const name of own.keys()) storage.sql.exec(`DELETE FROM ${quoteName(name)}`);
		storage.kv.put(IMPORT, { token } satisfies Import);
	});
}

function checkImport(storage: DurableObjectStorage, token: string): void {
	if (storage.kv.get<Import>(IMPORT)?.token !== token) {
		throw new Error("This object is not taking the rows of that move.");
	}
}

/** Writes a page of rows, in one transaction. */
export function writeForMove(storage: DurableObjectStorage, token: string, page: MoveRows[]): void {
	checkImport(storage, token);
	const tables = new Map(copiedTables(storage).map((table) => [table.name, table]));
	storage.transactionSync(() => {
		storage.sql.exec("PRAGMA defer_foreign_keys = ON");
		for (const { table: name, rows } of page) {
			const table = tables.get(name);
			if (!table) throw new Error(`No table ${name} here.`);
			const columns = ["rowid", ...table.columns].map(quoteName).join(", ");
			// A number is bound as a real; each column's affinity makes it what it was, and the
			// rowid has none.
			const values = ["CAST(? AS INTEGER)", ...table.columns.map(() => "?")].join(", ");
			const insert = `INSERT INTO ${quoteName(name)} (${columns}) VALUES (${values})`;
			for (const row of rows) {
				if (row.length !== table.columns.length + 1) throw new Error(`A row of ${name} is cut.`);
				storage.sql.exec(insert, ...row);
			}
		}
	});
}

/** Checks the copy against the manifest: every table's rows, its foreign keys and its version. */
export function checkCopy(
	storage: DurableObjectStorage,
	db: Db,
	token: string,
	manifest: MoveManifest,
): void {
	checkImport(storage, token);
	const short = manifest.tables
		.filter((table) => count(storage, table.name) !== table.rows)
		.map((table) => table.name);
	if (short.length > 0) throw new Error(`The copy's row counts differ in ${short.join(", ")}.`);
	if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length > 0) {
		throw new Error("The copy has rows whose references are missing.");
	}
	if (currentVersion(db) !== manifest.version) {
		throw new Error("The copy's version differs from the workspace's.");
	}
}

/**
 * Ends a move into this object, which holds the workspace's rows at `version` or later. Its
 * alarm can run from then on.
 */
export function endImport(storage: DurableObjectStorage, db: Db, version: number): void {
	if (currentVersion(db) < version) {
		throw new Error("This object doesn't hold the workspace that moved.");
	}
	storage.kv.delete(IMPORT);
}

/**
 * Settles where a move left the object as it starts: sealed, half filled, or frozen, as a freeze
 * outlives a restart until it lapses. One that lapsed ends here.
 */
export function moveStateAtStart(storage: DurableObjectStorage, now: number): MoveState {
	if (storage.kv.get(SEALED) !== undefined) return "sealed";
	if (isFrozen(storage, now)) return "frozen";
	thaw(storage);
	return storage.kv.get(IMPORT) !== undefined ? "importing" : null;
}

/** Whether a move's freeze holds the workspace at `now`: there is one, and it hasn't lapsed. */
export function isFrozen(storage: DurableObjectStorage, now: number): boolean {
	const until = freezeEnds(storage);
	return until !== null && until > now;
}

/**
 * A hash of each copied table's rows, rowid first, each value as SQLite quotes it, so that a value
 * that changed type differs too. Hashed a chunk at a time, each chunk with the hash before it, so
 * a large table needn't fit in memory.
 */
export async function digestTables(storage: DurableObjectStorage): Promise<Record<string, string>> {
	const encoder = new TextEncoder();
	const digests: Record<string, string> = {};
	for (const table of copiedTables(storage)) {
		const row = ["rowid", ...table.columns].map((column) => `quote(${quoteName(column)})`);
		let hash = "";
		let chunk = "";
		const add = async () => {
			const bytes = encoder.encode(`${hash}\n${chunk}`);
			hash = toHex(await crypto.subtle.digest("SHA-256", bytes));
			chunk = "";
		};
		for (const { line } of storage.sql.exec<{ line: string }>(
			`SELECT ${row.join(" || ',' || ")} AS line FROM ${quoteName(table.name)} ORDER BY rowid`,
		)) {
			chunk += `${line}\n`;
			if (chunk.length > 1_000_000) await add();
		}
		await add();
		digests[table.name] = hash;
	}
	return digests;
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The app's side.

/** The old object's calls in a move: a `WorkspaceDO` stub. */
export interface MoveSource {
	moveOut(token: string, to: string): Promise<MoveOut>;
	moveRead(token: string, cursor: MoveCursor, chars?: number): Promise<MovePage>;
	moveDigest(): Promise<Record<string, string>>;
	moveSeal(token: string): Promise<void>;
	moveThaw(token: string): Promise<Thawed>;
}

/** The new object's calls in a move: a `WorkspaceDO` stub. */
export interface MoveTarget {
	moveIn(token: string, manifest: MoveManifest): Promise<void>;
	moveWrite(token: string, page: MoveRows[]): Promise<void>;
	moveCheck(token: string, manifest: MoveManifest): Promise<void>;
	moveDigest(): Promise<Record<string, string>>;
	moveStart(version: number): Promise<void>;
}

export interface MoveReport {
	tables: number;
	rows: number;
	version: number;
	pages: number;
	/** True when an earlier move had copied and sealed it, and this one only finished it. */
	finished: boolean;
}

/** How many times the last steps are tried, as the workspace is out of reach between them. */
const LAST_STEP_TRIES = 5;

/**
 * Moves a workspace from one object to another, then has `record` note where it is now, so the
 * app reaches it there. Throws if the workspace stays where it was, frozen no more. Once the old
 * object is sealed, the workspace is out of reach until `record` has run: a move that dies there
 * is finished by the next, which finds it sealed.
 */
export async function moveWorkspace(
	from: MoveSource,
	to: MoveTarget,
	{
		label,
		record,
		pageChars,
		retryMs = 1000,
	}: {
		/** Where the workspace is going, as the app names it: kept by the old object once sealed. */
		label: string;
		record: () => Promise<void>;
		/** Smaller pages than usual, for tests. */
		pageChars?: number;
		/** The first wait before trying a last step again, doubling each time; shorter in tests. */
		retryMs?: number;
	},
): Promise<MoveReport> {
	const token = crypto.randomUUID();
	const out = await from.moveOut(token, label);
	if (!out.frozen) {
		if (out.sealedTo !== label) {
			throw new Error(`The workspace moved before, to ${out.sealedTo || "no jurisdiction"}.`);
		}
		await finish(to, out.version, record, retryMs);
		return { tables: 0, rows: 0, version: out.version, pages: 0, finished: true };
	}
	const { manifest } = out;
	let pages = 0;
	try {
		await to.moveIn(token, manifest);
		let cursor: MoveCursor | null = { table: 0, after: null };
		while (cursor) {
			const page: MovePage = await from.moveRead(token, cursor, pageChars);
			if (page.tables.length > 0) await to.moveWrite(token, page.tables);
			pages += 1;
			cursor = page.next;
		}
		await to.moveCheck(token, manifest);
		const [theirs, ours] = await Promise.all([from.moveDigest(), to.moveDigest()]);
		const differ = [...new Set([...Object.keys(theirs), ...Object.keys(ours)])].filter(
			(table) => theirs[table] !== ours[table],
		);
		if (differ.length > 0) throw new Error(`The copy differs in ${differ.join(", ")}.`);
		await from.moveSeal(token);
	} catch (error) {
		// If this fails too, the freeze lapses on its own. A seal whose answer was lost took effect.
		const thawed = await from.moveThaw(token).catch(() => "none" as const);
		if (thawed !== "sealed") throw error;
	}
	await finish(to, manifest.version, record, retryMs);
	return {
		tables: manifest.tables.length,
		rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
		version: manifest.version,
		pages,
		finished: false,
	};
}

async function finish(
	to: MoveTarget,
	version: number,
	record: () => Promise<void>,
	retryMs: number,
): Promise<void> {
	await retry(() => to.moveStart(version), retryMs);
	await retry(record, retryMs);
}

async function retry(step: () => Promise<void>, firstWaitMs: number): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await step();
			return;
		} catch (error) {
			if (attempt + 1 >= LAST_STEP_TRIES) throw error;
			await new Promise((resolve) => setTimeout(resolve, firstWaitMs * 2 ** attempt));
		}
	}
}
