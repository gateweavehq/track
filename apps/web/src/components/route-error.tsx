import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";
import { referenceIn } from "#/lib/error-reference";
import { isUnreachable } from "#/lib/offline";

/**
 * What a page shows when it fails to load, with a retry. Being offline gets an explanation.
 * Anything else gets no more than that it failed, never the error's own message: it comes from
 * the server, and what failed there may have put anything in it, as a failed database query once
 * put its statement and values (TRK-143). A reference, if the failure has one, is shown so that
 * whoever runs the server can find it in the log.
 */
export function RouteError({ error }: ErrorComponentProps) {
	const router = useRouter();
	const retry = (
		<Button variant="outline" onClick={() => void router.invalidate()}>
			Try again
		</Button>
	);
	if (isUnreachable(error)) {
		return (
			<Notice title="You're offline" action={retry}>
				This page needs a connection. Workspaces you have opened on this device open without one.
			</Notice>
		);
	}
	const reference = referenceIn(error);
	return (
		<Notice title="Something went wrong" action={retry}>
			This page could not be loaded.
			{reference && (
				<>
					{" "}
					If it keeps happening, whoever runs this server can find it in the log under the reference{" "}
					<code>{reference}</code>.
				</>
			)}
		</Notice>
	);
}
