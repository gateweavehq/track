import {
	type Activity,
	type ArchivedIssues,
	type ArchivedIssuesPage,
	archivedIssuesPage,
	type Comment,
	type Issue,
	type IssueDetails,
} from "@gateweave/track-protocol";
import { useSyncStatus } from "@gateweave/track-sync-client/react";
import { useCallback, useEffect, useState } from "react";

// The replica holds an archived issue slim (see "Archive" in docs/architecture.md). These ask the
// workspace's server for the rest, when there is a connection, and hand it to whoever asked: a
// page or an export. Nothing here is written into the replica or IndexedDB.

/**
 * The server could not be reached, or would not answer: the archived details are not here.
 * `reason` is the server's own word for a refusal (its `error`), when it gave one.
 */
export class ArchivedUnavailable extends Error {
	constructor(
		readonly status: number | null,
		readonly reason: string | null = null,
	) {
		super(
			status === null
				? "The server could not be reached"
				: `The server answered ${status} for archived issues`,
		);
		this.name = "ArchivedUnavailable";
	}
}

/**
 * More of the archive changed while it was read than an export asks for one at a time: it is
 * better exported again in a moment than with hundreds of requests.
 */
export class ArchiveChanging extends Error {
	constructor(readonly count: number) {
		super(`${count} archived issues changed on the server during the export`);
		this.name = "ArchiveChanging";
	}
}

function base(slug: string): string {
	return `/api/sync/${encodeURIComponent(slug)}`;
}

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new ArchivedUnavailable(null);
	}
	if (!response.ok) {
		// The gateway words each refusal, which tells a missing issue from a missing workspace.
		const body: unknown = await response.json().catch(() => null);
		const reason =
			body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
				? body.error
				: null;
		throw new ArchivedUnavailable(response.status, reason);
	}
	return (await response.json()) as T;
}

/** One issue whole, with its comments, history, open proposals and pull requests. */
export function fetchIssueDetails(
	slug: string,
	issueId: string,
	signal?: AbortSignal,
): Promise<IssueDetails> {
	return read(`${base(slug)}/issues/${encodeURIComponent(issueId)}`, signal);
}

/**
 * Every archived issue whole, or one team's, with their comments and history. The server answers
 * a page at a time, so that a large archive never has to fit in one answer; this asks for pages
 * until the last. Each issue is in the result once, as the latest page that had it says.
 */
export async function fetchArchivedIssues(
	slug: string,
	teamId: string | null,
	signal?: AbortSignal,
): Promise<ArchivedIssues> {
	const issues = new Map<string, Issue>();
	const comments = new Map<string, Comment>();
	const activities = new Map<string, Activity>();
	let after: string | null = null;
	for (let pages = 0; ; pages++) {
		// Far more than any archive needs (two million issues), so a server that never says the
		// last page is reached cannot have this ask forever.
		if (pages === MAX_ARCHIVE_PAGES) throw new Error("The archive's pages did not end");
		const query = new URLSearchParams();
		if (teamId !== null) query.set("team", teamId);
		// Always pages: without `page` or `after`, the server answers the whole list at once, as
		// v0.21.0 asks for it.
		if (after === null) query.set("page", "1");
		else query.set("after", after);
		const checked = archivedIssuesPage.safeParse(
			await read<unknown>(`${base(slug)}/archive?${query}`, signal),
		);
		// Not a page, such as a server from before pages, whose answer has no `next`: reading on
		// would ask for `after=undefined` again and again.
		if (!checked.success) throw new Error("The server's answer is not a page of the archive");
		const page = checked.data as unknown as ArchivedIssuesPage;
		for (const issue of page.issues) issues.set(issue.id, issue);
		for (const comment of page.comments) comments.set(comment.id, comment);
		for (const activity of page.activities) activities.set(activity.id, activity);
		if (page.next === null) break;
		// Only "moved on" is checked, not "moved up": JavaScript and SQLite order ids apart.
		if (page.next === after) throw new Error("The archive's pages did not move on");
		after = page.next;
	}
	return {
		issues: [...issues.values()],
		comments: [...comments.values()],
		activities: [...activities.values()],
	};
}

/** The most pages `fetchArchivedIssues` asks for before it gives up on the server. */
const MAX_ARCHIVE_PAGES = 10_000;

/** How many issues' details an export asks for at once, after the archive's pages. */
const DETAILS_AT_ONCE = 6;

/**
 * The most issues an export asks for one at a time when the archive left them out. Usually there
 * are none or a few; more means the archive is changing fast, and `ArchiveChanging` says so.
 */
export const MAX_MISSING_ARCHIVED = 50;

/** The gateway's word for an issue it does not have, as opposed to a workspace it hides. */
const ISSUE_NOT_FOUND = "Issue not found";

/**
 * The issues of `ids` whole, which the replica holds archived but the server's archive did not
 * list: restored, or archived again, while the export was made. Those archived on the server go
 * with `archived`; those it restored come back apart, to be exported with the issues that are not
 * archived. A deleted one is in neither, as it is not in the workspace. More than
 * `MAX_MISSING_ARCHIVED` throw `ArchiveChanging` without asking.
 */
export async function fetchMissingArchived(
	slug: string,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<{ archived: ArchivedIssues; restored: ArchivedIssues }> {
	if (ids.length > MAX_MISSING_ARCHIVED) throw new ArchiveChanging(ids.length);
	const archived: ArchivedIssues = { issues: [], comments: [], activities: [] };
	const restored: ArchivedIssues = { issues: [], comments: [], activities: [] };
	const queue = [...ids];
	const worker = async () => {
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			let details: IssueDetails;
			try {
				details = await fetchIssueDetails(slug, id, signal);
			} catch (error) {
				// Only the issue is gone. "Workspace not found" (no longer a member, say) fails the
				// export like any other refusal.
				const gone =
					error instanceof ArchivedUnavailable &&
					error.status === 404 &&
					error.reason === ISSUE_NOT_FOUND;
				if (gone) continue;
				throw error;
			}
			const into = details.issue.archivedAt === null ? restored : archived;
			into.issues.push(details.issue);
			into.comments.push(...details.comments);
			into.activities.push(...details.activities);
		}
	};
	await Promise.all(Array.from({ length: Math.min(DETAILS_AT_ONCE, ids.length) }, worker));
	return { archived, restored };
}

/**
 * What an export that could not fetch the archived issues says, by how the server answered: not
 * at all (offline), signed out, not found (or no longer a member, which looks the same), or with
 * an error of its own; or the archive changing faster than it could be read (`"changing"`).
 * `status` is null without an answer; `issues` names them ("3 archived issues") and `count` is
 * how many.
 */
export function archivedFailure(
	status: number | null | "changing",
	issues: string,
	count: number,
): { title: string; description: string } {
	if (status === "changing") {
		return {
			title: "Not exported: the archive is changing",
			description: `Many archived issues were restored or archived on the server while the export was made, so it did not include ${issues}. Export again in a moment, or export without them.`,
		};
	}
	if (status === null) {
		return {
			title: `Not exported: ${issues} ${count === 1 ? "needs" : "need"} a connection`,
			description:
				"This browser keeps only a short record of archived issues; the rest is on the server, which could not be reached. Export again when online, or export without them.",
		};
	}
	if (status === 401) {
		return {
			title: "Not exported: signed out",
			description: `The server sends archived issues only to members who are signed in. Sign in again to include ${issues}, or export without them.`,
		};
	}
	if (status === 403 || status === 404) {
		return {
			title: "Not exported: workspace not found",
			description: `The server did not find this workspace for you, so it sent no archived issues: it may have been deleted, or you may no longer be a member. You can still export without the ${issues}.`,
		};
	}
	if (status >= 500) {
		return {
			title: "Not exported: the server had an error",
			description: `The server could not send ${issues} this time. Try again in a moment, or export without them.`,
		};
	}
	return {
		title: `Not exported: the server refused ${issues}`,
		description: `It answered ${status}. Export again, or export without them.`,
	};
}

export type IssueDetailsState =
	/** Asking the server. */
	| { status: "loading" }
	| { status: "loaded"; details: IssueDetails }
	/** No connection: the page shows what the replica has. */
	| { status: "offline" }
	/** The server was reached and did not answer with the issue. */
	| { status: "failed"; retry: () => void };

/**
 * The whole of an issue from the server while this browser is connected, for the page of an
 * archived one. Without a connection it is `offline`, whatever was loaded before, so the page
 * shows what the replica has. It asks again when the connection comes back and when `revision`
 * changes (pass the replica's slim row, which changes with every write to the issue). Kept in
 * component state only, never in the replica.
 */
export function useIssueDetails(
	slug: string,
	issueId: string,
	revision: unknown,
): IssueDetailsState {
	const { connection } = useSyncStatus();
	// While a connection is being made, the page waits rather than flickering between states.
	const settled = connection === "connecting" ? null : connection === "live";
	const [online, setOnline] = useState(settled ?? true);
	if (settled !== null && settled !== online) setOnline(settled);

	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<IssueDetailsState>({ status: "loading" });
	const retry = useCallback(() => setAttempt((count) => count + 1), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision and attempt only ask again
	useEffect(() => {
		if (!online) {
			setState({ status: "offline" });
			return;
		}
		const controller = new AbortController();
		setState((current) => (current.status === "loaded" ? current : { status: "loading" }));
		fetchIssueDetails(slug, issueId, controller.signal).then(
			(details) => setState({ status: "loaded", details }),
			(error: unknown) => {
				if (controller.signal.aborted) return;
				// Lost on the way: the connection status follows, and with it another try.
				const lost = error instanceof ArchivedUnavailable && error.status === null;
				setState(lost ? { status: "offline" } : { status: "failed", retry });
			},
		);
		return () => controller.abort();
	}, [slug, issueId, online, revision, attempt, retry]);

	if (!online) return { status: "offline" };
	// Moved on to another issue: what was loaded is the last one's.
	if (state.status === "loaded" && state.details.issue.id !== issueId) return { status: "loading" };
	return state;
}
