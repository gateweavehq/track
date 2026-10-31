import {
	compactDisplay,
	type IssueDisplay,
	type IssueFilters,
	type IssueLayout,
	type SavedView,
	sameDisplay,
} from "@gateweave/track-protocol";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { FILTER_KEYS } from "#/components/issues/filter-menu";
import { IssuesPage } from "#/components/issues/issues-page";
import { Button } from "#/components/ui/button";
import { ViewChanges, ViewMenu } from "#/components/views/view-controls";
import { useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import type { DisplayUpdate } from "#/lib/display";
import { compactFilters, type FiltersUpdate, sameFilters } from "#/lib/filters";
import { useIssues, useSavedView } from "#/lib/queries";
import { canEditView, isViewVisible } from "#/lib/saved-views";
import { useDocumentTitle } from "#/lib/title";

// A view's filters say which issues it shows, from the whole workspace.
const everyIssue = () => true;
const NO_DEFAULTS = {};

export const Route = createFileRoute("/$workspace/view/$viewId")({
	component: ViewPage,
});

function ViewPage() {
	const { workspace, viewId } = Route.useParams();
	const { userId } = useWorkspace();
	const view = useSavedView(viewId);
	const visible = view && isViewVisible(view, userId);
	useDocumentTitle(visible ? view.name : undefined);

	if (!visible) {
		return (
			<Notice
				title="View not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace }}>
							Back to the workspace
						</Link>
					</Button>
				}
			>
				It may have been deleted, or made personal by the person who saved it.
			</Notice>
		);
	}
	// Keyed by view, so going from one view to another drops the changes made to the first.
	return <ViewIssues key={view.id} view={view} />;
}

interface Draft {
	filters: IssueFilters;
	layout: IssueLayout;
	display: IssueDisplay;
}

/** What the view holds, as a draft. */
const draftOf = (view: SavedView): Draft => ({
	filters: view.filters,
	layout: view.layout,
	display: compactDisplay(view.display),
});

function ViewIssues({ view }: { view: SavedView }) {
	const { userId } = useWorkspace();
	const role = useMyRole();
	const issues = useIssues(everyIssue);
	// Changes not saved yet, kept here rather than in the URL so that the view's link stays the
	// view. Null while there are none, so a change someone else saves shows up at once.
	const [draft, setDraft] = useState<Draft | null>(null);
	// Memoized because rows are: options rebuilt on every render would redraw each of them.
	const saved = useMemo(() => draftOf(view), [view]);
	const shown: Draft = draft ?? saved;

	const change = useCallback(
		(update: (current: Draft) => Draft) =>
			setDraft((current) => {
				const next = update(current ?? saved);
				const filters = compactFilters(next.filters);
				const display = compactDisplay(next.display);
				return next.layout === view.layout &&
					sameFilters(filters, view.filters) &&
					sameDisplay(display, view.display)
					? null
					: { filters, layout: next.layout, display };
			}),
		[view, saved],
	);
	const onFiltersChange = useCallback(
		(update: FiltersUpdate) =>
			change((current) => ({ ...current, filters: update(current.filters) })),
		[change],
	);
	const onDisplayChange = useCallback(
		(update: DisplayUpdate) =>
			change((current) => ({ ...current, display: update(current.display) })),
		[change],
	);
	const onViewChange = useCallback(
		(layout: IssueLayout) => change((current) => ({ ...current, layout })),
		[change],
	);
	const canEdit = canEditView(view, userId, role);

	return (
		<IssuesPage
			scope={`view.${view.id}`}
			title={view.name}
			badge={<ViewMenu view={view} canEdit={canEdit} />}
			issues={issues}
			defaults={NO_DEFAULTS}
			view={shown.layout}
			onViewChange={onViewChange}
			filters={shown.filters}
			onFiltersChange={onFiltersChange}
			display={shown.display}
			onDisplayChange={onDisplayChange}
			offeredFilters={FILTER_KEYS}
			filterActions={
				draft && (
					<ViewChanges
						view={view}
						filters={draft.filters}
						layout={draft.layout}
						display={draft.display}
						canEdit={canEdit}
						onSaved={() => setDraft(null)}
						onReset={() => setDraft(null)}
					/>
				)
			}
			empty={
				<Notice title="No issues yet">Issues that match this view's filters show up here.</Notice>
			}
		/>
	);
}
