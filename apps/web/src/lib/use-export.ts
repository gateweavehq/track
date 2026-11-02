import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { toast } from "sonner";
import { useWorkspace } from "#/components/workspace/context";
import { today } from "./dates";
import {
	archivedInExport,
	downloadText,
	type ExportFormat,
	exportFileName,
	exportSourceFrom,
	issuesToCsv,
	workspaceToJson,
} from "./export";

/**
 * Returns a function that downloads an export of the workspace as this browser's replica holds
 * it: all teams, or the one with this id. It reads the replica when called, not when rendered.
 * Archived issues come with only what the replica holds of them, and the person is told so.
 */
export function useExportIssues(): (format: ExportFormat, teamId?: string | null) => void {
	const client = useSyncClient();
	const { slug, name } = useWorkspace();
	return useCallback(
		(format, teamId = null) => {
			const state = client.getState();
			const source = exportSourceFrom(state, { slug, name });
			const text = format === "csv" ? issuesToCsv(source, teamId) : workspaceToJson(source, teamId);
			const teamKey = teamId ? (state.teams.get(teamId)?.key ?? null) : null;
			downloadText(exportFileName(slug, teamKey, today(), format), text, format);
			const archived = archivedInExport(source, teamId);
			if (archived > 0) {
				toast.info(
					`${archived} archived ${archived === 1 ? "issue is" : "issues are"} exported without details`,
					{
						description:
							"This browser keeps only their key, title, status, project, cycle, parent and estimate. Restore an issue to export all of it.",
					},
				);
			}
		},
		[client, slug, name],
	);
}
