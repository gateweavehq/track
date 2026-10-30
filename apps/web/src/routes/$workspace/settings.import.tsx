import { createFileRoute } from "@tanstack/react-router";
import { ImportSettings } from "#/components/settings/import-settings";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/import")({
	component: ImportPage,
});

function ImportPage() {
	useDocumentTitle("Import");
	return <ImportSettings />;
}
