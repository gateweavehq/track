import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { toast } from "sonner";
import { useWorkspace } from "#/components/workspace/context";
import {
	ArchiveChanging,
	ArchivedUnavailable,
	archivedFailure,
	fetchArchivedIssues,
	fetchMissingArchived,
} from "./archived";
import { today } from "./dates";
import {
	archivedInExport,
	archivedNotListed,
	downloadText,
	type ExportFormat,
	type ExportSource,
	exportFileName,
	exportSourceFrom,
	issuesToCsv,
	workspaceToJson,
} from "./export";

/**
 * Returns a function that downloads an export of the workspace: all teams, or the one with this
 * id. Active issues come from this browser's replica, read when called. Archived issues, which
 * the replica holds slim, come whole from the server, page by page. Without them the export stops
 * and says why, offering to export without them; it never drops them unannounced.
 */
export function useExportIssues(): (format: ExportFormat, teamId?: string | null) => void {
	const client = useSyncClient();
	const { slug, name } = useWorkspace();
	return useCallback(
		(format, teamId = null) => {
			const workspace = { slug, name };
			const save = (source: ExportSource) => {
				const text =
					format === "csv" ? issuesToCsv(source, teamId) : workspaceToJson(source, teamId);
				const teamKey = teamId ? (client.getState().teams.get(teamId)?.key ?? null) : null;
				downloadText(exportFileName(slug, teamKey, today(), format), text, format);
			};
			const local = exportSourceFrom(client.getState(), workspace);
			const archived = archivedInExport(local, teamId);
			if (archived === 0) {
				save(local);
				return;
			}
			const issues = archived === 1 ? "1 archived issue" : `${archived} archived issues`;
			const id = toast.loading(`Fetching ${issues} from the server…`);
			const fetchWhole = async () => {
				const listed = await fetchArchivedIssues(slug, teamId);
				// The replica may still hold an issue archived that the server has restored since,
				// which the archive no longer lists: it is asked for alone, so that it is exported.
				const notListed = archivedNotListed(
					exportSourceFrom(client.getState(), workspace),
					listed,
					teamId,
				);
				if (notListed.length === 0) return { archived: listed, restored: null };
				const missing = await fetchMissingArchived(slug, notListed);
				return {
					archived: {
						issues: [...listed.issues, ...missing.archived.issues],
						comments: [...listed.comments, ...missing.archived.comments],
						activities: [...listed.activities, ...missing.archived.activities],
					},
					restored: missing.restored,
				};
			};
			fetchWhole().then(
				(whole) => {
					toast.dismiss(id);
					// The replica as it is now, which the server's answer is at least as new as.
					save({ ...exportSourceFrom(client.getState(), workspace), ...whole });
				},
				(error: unknown) => {
					// Anything but a status of the server's, or a changing archive, is a failure of its
					// answer, such as one that is not a page.
					const status =
						error instanceof ArchivedUnavailable
							? error.status
							: error instanceof ArchiveChanging
								? "changing"
								: 500;
					const { title, description } = archivedFailure(status, issues, archived);
					toast.error(title, {
						id,
						duration: Number.POSITIVE_INFINITY,
						description,
						action: {
							label: "Export without them",
							onClick: () => {
								save(local);
								toast.warning(`Exported without ${issues}`, {
									description:
										format === "json"
											? "The file's notes say they are left out."
											: "The file has only the issues that are not archived.",
								});
							},
						},
					});
				},
			);
		},
		[client, slug, name],
	);
}
