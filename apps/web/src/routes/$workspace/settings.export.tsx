import { createFileRoute } from "@tanstack/react-router";
import { ExportSettings } from "#/components/settings/export-settings";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/export")({
	component: ExportPage,
});

function ExportPage() {
	useDocumentTitle("Export");
	return <ExportSettings />;
}
