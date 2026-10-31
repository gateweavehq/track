import { MENTION_SCHEME, mentionedId } from "@gateweave/track-protocol";
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isAttachmentPath } from "#/lib/attachments";
import { cn } from "#/lib/utils";

// Markdown as people write it in descriptions and comments: GitHub's flavor, with tables, task
// lists and strikethrough. HTML in the text shows as text, and links keep only safe protocols
// (react-markdown's defaults) and mentions. Loaded on its own, through `Markdown`, by the pages
// that need it.

/** Members' current names, by id, for mentions. */
export type MemberNames = ReadonlyMap<string, { name: string }>;

const Members = createContext<MemberNames>(new Map());

/**
 * Renders Markdown, with mentions under the names in `members`. Use `Markdown` from
 * `./markdown`, which loads this when it is needed.
 */
export function MarkdownView({
	source,
	className,
	members = new Map(),
}: {
	source: string;
	className?: string;
	members?: MemberNames;
}) {
	return (
		<div className={cn("text-sm leading-relaxed break-words", className)}>
			<Members value={members}>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={COMPONENTS}
					urlTransform={keepMentions}
				>
					{source}
				</ReactMarkdown>
			</Members>
		</div>
	);
}

function keepMentions(url: string): string {
	return url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url);
}

/** A mention shows the member's name as it is now; one who is not known, as it was written. */
function Mention({ memberId, children }: { memberId: string; children: ReactNode }) {
	const member = useContext(Members).get(memberId);
	return (
		<span
			data-mention={memberId}
			className="rounded-sm bg-primary/10 px-0.5 font-medium text-primary"
		>
			{member ? `@${member.name}` : children}
		</span>
	);
}

/** Links to other sites open in a new tab and pass nothing about the page they came from. */
function MarkdownLink({ href, children, node: _node, ...props }: ComponentProps<"a"> & Node) {
	const memberId = mentionedId(href);
	if (memberId !== null) return <Mention memberId={memberId}>{children}</Mention>;
	// "//host/path" is another site too. Files open in a tab of their own.
	const inApp = href?.startsWith("/") && !href.startsWith("//") && !isAttachmentPath(href);
	return (
		<a
			{...props}
			href={href}
			{...(!inApp && { target: "_blank", rel: "noopener noreferrer nofollow" })}
			className="font-medium text-primary underline underline-offset-2 hover:no-underline"
		>
			{children}
		</a>
	);
}

/**
 * Only files attached in the workspace show as images. An image from anywhere else would tell
 * its host who read the issue and when, so it shows as a link to follow on purpose.
 */
function MarkdownImage({ src, alt, node: _node }: ComponentProps<"img"> & Node) {
	if (typeof src !== "string" || !src) return null;
	if (!isAttachmentPath(src)) {
		return <MarkdownLink href={src}>{alt || src}</MarkdownLink>;
	}
	return (
		<a href={src} target="_blank" rel="noopener" className="inline-block max-w-full align-top">
			<img
				src={src}
				alt={alt ?? ""}
				loading="lazy"
				className="max-h-96 max-w-full rounded-md border bg-muted/40"
			/>
		</a>
	);
}

/** react-markdown passes the syntax tree node along; it must not reach the DOM. */
interface Node {
	node?: unknown;
}

const COMPONENTS: Components = {
	a: MarkdownLink,
	img: MarkdownImage,
	p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
	h1: ({ node: _node, ...props }) => (
		<h1 className="mt-5 mb-2 text-xl font-semibold first:mt-0" {...props} />
	),
	h2: ({ node: _node, ...props }) => (
		<h2 className="mt-5 mb-2 text-lg font-semibold first:mt-0" {...props} />
	),
	h3: ({ node: _node, ...props }) => (
		<h3 className="mt-4 mb-1.5 text-base font-semibold first:mt-0" {...props} />
	),
	h4: ({ node: _node, ...props }) => (
		<h4 className="mt-4 mb-1.5 font-semibold first:mt-0" {...props} />
	),
	h5: ({ node: _node, ...props }) => (
		<h5 className="mt-3 mb-1 font-semibold first:mt-0" {...props} />
	),
	h6: ({ node: _node, ...props }) => (
		<h6 className="mt-3 mb-1 font-semibold text-muted-foreground first:mt-0" {...props} />
	),
	ul: ({ node: _node, className, ...props }) => (
		<ul
			className={cn(
				"my-2 pl-5 first:mt-0 last:mb-0",
				className === "contains-task-list" ? "list-none pl-1" : "list-disc",
			)}
			{...props}
		/>
	),
	ol: ({ node: _node, ...props }) => (
		<ol className="my-2 list-decimal pl-5 first:mt-0 last:mb-0" {...props} />
	),
	li: ({ node: _node, ...props }) => <li className="my-0.5 [&>input]:mr-1.5" {...props} />,
	input: ({ node: _node, ...props }) => (
		<input {...props} className="align-middle accent-primary" />
	),
	blockquote: ({ node: _node, ...props }) => (
		<blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props} />
	),
	hr: ({ node: _node, ...props }) => <hr className="my-4 border-border" {...props} />,
	code: ({ node: _node, ...props }) => (
		<code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />
	),
	pre: ({ node: _node, ...props }) => (
		<pre
			className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-normal [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]"
			{...props}
		/>
	),
	table: ({ node: _node, ...props }) => (
		<div className="my-2 overflow-x-auto">
			<table className="border-collapse text-sm" {...props} />
		</div>
	),
	th: ({ node: _node, ...props }) => (
		<th className="border bg-muted/40 px-2 py-1 text-left font-medium" {...props} />
	),
	td: ({ node: _node, ...props }) => <td className="border px-2 py-1" {...props} />,
};
