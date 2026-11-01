import { createFileRoute } from "@tanstack/react-router";
import { TemplatesSettings } from "#/components/settings/templates-settings";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/templates")({
	component: TemplatesPage,
});

function TemplatesPage() {
	useDocumentTitle("Templates");
	return <TemplatesSettings />;
}
