import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "#/components/inbox/inbox-page";
import { inboxSearch } from "#/lib/inbox";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/inbox")({
	validateSearch: inboxSearch,
	component: Inbox,
});

function Inbox() {
	const { tab = "inbox" } = Route.useSearch();
	useDocumentTitle("Inbox");
	return <InboxPage tab={tab} />;
}
