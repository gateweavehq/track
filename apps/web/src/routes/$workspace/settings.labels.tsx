import { createFileRoute } from "@tanstack/react-router";
import { LabelsSettings } from "#/components/settings/labels-settings";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/labels")({
	component: LabelsPage,
});

function LabelsPage() {
	useDocumentTitle("Labels");
	return <LabelsSettings />;
}
