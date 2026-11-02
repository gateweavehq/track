import type {
	Activity,
	ArchivedIssues,
	ArchivedIssuesPage,
	Comment,
	Issue,
	IssueDetails,
} from "@gateweave/track-protocol";
import { useSyncStatus } from "@gateweave/track-sync-client/react";
import { useCallback, useEffect, useState } from "react";

// The replica holds an archived issue slim (see "Archive" in docs/architecture.md). These ask the
// workspace's server for the rest, when there is a connection, and hand it to whoever asked: a
// page or an export. Nothing here is written into the replica or IndexedDB.

/** The server could not be reached, or would not answer: the archived details are not here. */
export class ArchivedUnavailable extends Error {
	constructor(readonly status: number | null) {
		super(
			status === null
				? "The server could not be reached"
				: `The server answered ${status} for archived issues`,
		);
		this.name = "ArchivedUnavailable";
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
	if (!response.ok) throw new ArchivedUnavailable(response.status);
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
	do {
		const query = new URLSearchParams();
		if (teamId !== null) query.set("team", teamId);
		if (after !== null) query.set("after", after);
		const search = query.size === 0 ? "" : `?${query}`;
		const page: ArchivedIssuesPage = await read(`${base(slug)}/archive${search}`, signal);
		for (const issue of page.issues) issues.set(issue.id, issue);
		for (const comment of page.comments) comments.set(comment.id, comment);
		for (const activity of page.activities) activities.set(activity.id, activity);
		// Pages go forward by id. One that did not would have this ask forever.
		if (page.next !== null && after !== null && page.next <= after) {
			throw new Error("The archive's pages did not move on");
		}
		after = page.next;
	} while (after !== null);
	return {
		issues: [...issues.values()],
		comments: [...comments.values()],
		activities: [...activities.values()],
	};
}

/** How many issues' details an export asks for at once, after the archive's pages. */
const DETAILS_AT_ONCE = 6;

/**
 * The issues of `ids` whole, which the replica holds archived but the server's archive did not
 * list: restored, or archived again, while the export was made. Those archived on the server go
 * with `archived`; those it restored come back apart, to be exported with the issues that are not
 * archived. A deleted one is in neither, as it is not in the workspace.
 */
export async function fetchMissingArchived(
	slug: string,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<{ archived: ArchivedIssues; restored: ArchivedIssues }> {
	const archived: ArchivedIssues = { issues: [], comments: [], activities: [] };
	const restored: ArchivedIssues = { issues: [], comments: [], activities: [] };
	const queue = [...ids];
	const worker = async () => {
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			let details: IssueDetails;
			try {
				details = await fetchIssueDetails(slug, id, signal);
			} catch (error) {
				if (error instanceof ArchivedUnavailable && error.status === 404) continue;
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
 * an error of its own. `status` is null without an answer; `issues` names them ("3 archived
 * issues") and `count` is how many.
 */
export function archivedFailure(
	status: number | null,
	issues: string,
	count: number,
): { title: string; description: string } {
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
