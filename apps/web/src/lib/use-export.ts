import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { toast } from "sonner";
import { useWorkspace } from "#/components/workspace/context";
import { fetchArchivedIssues } from "./archived";
import { today } from "./dates";
import {
	archivedInExport,
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
 * the replica holds slim, come whole from the server. Without a connection the export stops and
 * says so, offering to export without them; it never drops them unannounced.
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
			fetchArchivedIssues(slug, teamId).then(
				(whole) => {
					toast.dismiss(id);
					// The replica as it is now, which the server's answer is at least as new as.
					save({ ...exportSourceFrom(client.getState(), workspace), archived: whole });
				},
				() => {
					toast.error(`Not exported: ${issues} ${archived === 1 ? "needs" : "need"} a connection`, {
						id,
						duration: Number.POSITIVE_INFINITY,
						description:
							"This browser keeps only a short record of archived issues; the rest is on the server, which could not be reached. Export again when online, or export without them.",
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
