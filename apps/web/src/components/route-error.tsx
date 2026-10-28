import { ErrorComponent, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { isUnreachable } from "#/lib/offline";

/** What a page shows when it fails to load. Being offline gets an explanation and a retry. */
export function RouteError({ error }: ErrorComponentProps) {
	const router = useRouter();
	if (!isUnreachable(error)) return <ErrorComponent error={error} />;
	return (
		<Notice
			title="You're offline"
			action={
				<Button variant="outline" onClick={() => void router.invalidate()}>
					Try again
				</Button>
			}
		>
			This page needs a connection. Workspaces you have opened on this device open without one.
		</Notice>
	);
}
