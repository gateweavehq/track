import { useSyncClient } from "@gateweave/track-sync-client/react";
import { useCallback } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { today } from "./dates";
import {
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
		},
		[client, slug, name],
	);
}
