import { createServerFn } from "@tanstack/react-start";

/**
 * What this server's ways in for requests can do: whether forms take requests (it has
 * Turnstile's keys), and the domain of intake email addresses, or null when they are off.
 */
export const getIntakeOptions = createServerFn({ method: "GET" }).handler(async () => {
	const { intakeFormsEnabled } = await import("#/server/intake-form");
	const { intakeEmailDomain } = await import("#/server/intake-email");
	return { forms: intakeFormsEnabled(), emailDomain: intakeEmailDomain() };
});

/** The public link to a team's request form. */
export function intakeFormUrl(workspaceId: string, formKey: string): string {
	return `${window.location.origin}/request/${encodeURIComponent(workspaceId)}/${formKey}`;
}
