import type { ArchivedIssues, IssueDetails } from "@gateweave/track-protocol";
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

/** Every archived issue whole, or one team's, with their comments and history. */
export function fetchArchivedIssues(
	slug: string,
	teamId: string | null,
	signal?: AbortSignal,
): Promise<ArchivedIssues> {
	const query = teamId === null ? "" : `?${new URLSearchParams({ team: teamId })}`;
	return read(`${base(slug)}/archive${query}`, signal);
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
