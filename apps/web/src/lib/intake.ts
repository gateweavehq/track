import { createServerFn } from "@tanstack/react-start";

/** Whether this server's request forms take requests: it has Turnstile's keys, and is no demo. */
export const getIntakeFormsEnabled = createServerFn({ method: "GET" }).handler(async () => {
	const { intakeFormsEnabled } = await import("#/server/intake-form");
	return intakeFormsEnabled();
});

/** The public link to a team's request form. */
export function intakeFormUrl(workspaceId: string, formKey: string): string {
	return `${window.location.origin}/request/${encodeURIComponent(workspaceId)}/${formKey}`;
}
