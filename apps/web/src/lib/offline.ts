import type { getWorkspace } from "./workspace";

// What this browser remembers about the signed-in user's workspaces, so that one already on the
// device can open without a connection. It holds only what the loaders would otherwise ask the
// server for: ids, names and roles. The issues themselves live in each workspace's replica.

export type KnownWorkspace = NonNullable<Awaited<ReturnType<typeof getWorkspace>>>;

interface Memory {
	userId: string;
	/** By slug, as they appear in URLs. */
	workspaces: Record<string, KnownWorkspace>;
	/** The slug opened most recently, where an installed app starts without a connection. */
	last?: string;
}

const KEY = "track:workspaces";

/** A page needs the server, and the server cannot be reached. */
export class OfflineError extends Error {
	constructor() {
		super("You are offline");
		this.name = "OfflineError";
	}
}

/**
 * Whether an error means the server could not be reached, as opposed to the server refusing.
 * A refusal must never fall back to what the device remembers.
 */
export function isUnreachable(error: unknown): boolean {
	if (error instanceof OfflineError) return true;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
	// What fetch rejects with when there is no response: Chrome, Firefox and Safari word it apart.
	return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

/**
 * Asks the server, and when it cannot be reached, uses what `fallback` finds on the device.
 * With nothing there either, throws `OfflineError`.
 */
export async function withOfflineFallback<T>(
	request: () => Promise<T>,
	fallback: () => T | undefined,
): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (!isUnreachable(error)) throw error;
		const known = fallback();
		if (known === undefined) throw new OfflineError();
		return known;
	}
}

export function rememberWorkspace(slug: string, workspace: KnownWorkspace): void {
	const memory = read();
	// Another account signed in here: what the last one could open is not this one's to open.
	const workspaces = memory?.userId === workspace.userId ? memory.workspaces : {};
	write({ userId: workspace.userId, workspaces: { ...workspaces, [slug]: workspace }, last: slug });
}

export function knownWorkspace(slug: string): KnownWorkspace | undefined {
	return read()?.workspaces[slug];
}

export function lastWorkspace(): string | undefined {
	const memory = read();
	return memory?.last && memory.workspaces[memory.last] ? memory.last : undefined;
}

/** Forgets a workspace by slug, or by id under every slug it had. */
export function forgetKnownWorkspace(match: { slug: string } | { id: string }): void {
	const memory = read();
	if (!memory) return;
	const workspaces = Object.fromEntries(
		Object.entries(memory.workspaces).filter(([slug, workspace]) =>
			"slug" in match ? slug !== match.slug : workspace.id !== match.id,
		),
	);
	const last = memory.last && workspaces[memory.last] ? memory.last : undefined;
	write({ userId: memory.userId, workspaces, last });
}

export function forgetAllWorkspaces(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// Storage is unavailable, so there is nothing to forget.
	}
}

function read(): Memory | undefined {
	try {
		const value = localStorage.getItem(KEY);
		return value ? (JSON.parse(value) as Memory) : undefined;
	} catch {
		return undefined;
	}
}

function write(memory: Memory): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(memory));
	} catch {
		// Without storage the app still works online; it just cannot start offline.
	}
}
