import { Info } from "lucide-react";

export const REPOSITORY_URL = "https://github.com/gateweavehq/track";
export const SELF_HOSTING_URL = `${REPOSITORY_URL}/blob/main/docs/self-hosting.md`;

/** Tells visitors on the public demo that nothing they do here lasts, and where to go next. */
export function DemoBanner() {
	return (
		<div
			role="status"
			className="flex shrink-0 items-start gap-2 border-b bg-accent px-4 py-2 text-xs text-foreground/80"
		>
			<Info className="mt-0.5 size-3.5 shrink-0" />
			<p>
				This is a demo. This workspace is private to you and will be deleted a day after you opened
				it.{" "}
				<a
					href={REPOSITORY_URL}
					className="font-medium text-foreground underline underline-offset-4"
					target="_blank"
					rel="noreferrer"
				>
					Deploy your own
				</a>{" "}
				(
				<a
					href={SELF_HOSTING_URL}
					className="font-medium text-foreground underline underline-offset-4"
					target="_blank"
					rel="noreferrer"
				>
					self-hosting guide
				</a>
				).
			</p>
		</div>
	);
}
