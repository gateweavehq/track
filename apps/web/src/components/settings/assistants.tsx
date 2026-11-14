import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { LiveButton } from "#/components/live-button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";
import { type AssistantGrant, takeBackAssistant } from "#/lib/oauth";

/**
 * The AI assistants the person allowed on the consent page. Each acts as them in every workspace
 * until they take it back, which also ends the access token it holds.
 */
export function Assistants({ grants }: { grants: AssistantGrant[] }) {
	const router = useRouter();
	const [leaving, setLeaving] = useState<AssistantGrant | null>(null);

	async function takeBack(grant: AssistantGrant) {
		try {
			await takeBackAssistant({ data: grant.clientId });
		} catch {
			toast.error("Could not take access back. Try again.");
			return;
		}
		// Gone either way: a grant that was already gone needs no second try.
		await router.invalidate();
		toast.success(`${grant.name ?? "The app"} no longer has access`);
	}

	return (
		<section aria-labelledby="assistants-heading" className="space-y-4">
			<h2 id="assistants-heading" className="text-sm font-semibold">
				Assistants you allowed
			</h2>
			{grants.length === 0 ? (
				<p className="rounded-lg border p-4 text-sm text-muted-foreground">
					No assistant has access.
				</p>
			) : (
				<>
					<p className="text-sm text-muted-foreground">
						These apps act as you in every workspace you belong to.
					</p>
					<ul className="divide-y rounded-lg border">
						{grants.map((grant) => (
							<li
								key={grant.clientId}
								className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4"
							>
								<div className="min-w-0 space-y-0.5 text-sm">
									<p className="break-words font-medium">
										{grant.name ?? "An unnamed app"}{" "}
										<span className="font-normal text-muted-foreground">named by the app</span>
									</p>
									<p className="break-words text-muted-foreground">Goes to {grant.goesTo}</p>
									<p className="text-muted-foreground">
										Allowed {formatShortDate(grant.allowedAt)}
										{" · "}
										{grant.lastUsedAt ? (
											<span title={formatDateTime(grant.lastUsedAt)}>
												Last used {formatRelative(grant.lastUsedAt)}
											</span>
										) : (
											"Not used yet"
										)}
									</p>
								</div>
								<LiveButton variant="outline" size="sm" onClick={() => setLeaving(grant)}>
									Take back
								</LiveButton>
							</li>
						))}
					</ul>
				</>
			)}
			{leaving && (
				<ConfirmDialog
					title="Take back access?"
					confirmLabel="Take back"
					onClose={() => setLeaving(null)}
					onConfirm={() => takeBack(leaving)}
				>
					{leaving.name ?? "The app"} loses access at once. It can ask again, and you would see the
					consent page.
				</ConfirmDialog>
			)}
		</section>
	);
}
