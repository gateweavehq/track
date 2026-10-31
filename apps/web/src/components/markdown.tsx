import { lazy, Suspense } from "react";
import { useMembersById } from "#/lib/queries";
import { cn } from "#/lib/utils";

// The Markdown renderer is most of a chunk on its own, and only issue pages need it, so it loads
// with the first of them instead of with every page. Until it arrives the text shows as written.
const MarkdownView = lazy(() =>
	import("./markdown-view").then((module) => ({ default: module.MarkdownView })),
);

export function Markdown({ source, className }: { source: string; className?: string }) {
	const members = useMembersById();
	return (
		<Suspense
			fallback={
				<div className={cn("text-sm leading-relaxed break-words whitespace-pre-wrap", className)}>
					{source}
				</div>
			}
		>
			<MarkdownView source={source} className={className} members={members} />
		</Suspense>
	);
}
