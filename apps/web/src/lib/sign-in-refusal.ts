const NOT_CONNECTABLE =
	"The app that sent you here cannot connect to this server as it is set up. Go back to it and start again.";

const REFUSALS: Record<string, string> = {
	access_denied: "You chose not to sign in that way.",
	account_not_linked:
		"This address already has an account here, and we could not confirm it is yours. Sign in with your password. If you have not verified the address yet, do that first.",
	email_not_found: "We were not given an email address for you, and an account needs one.",
	// The way back no longer matched the way out: ten minutes had passed, another tab had started a
	// sign-in since, or the same return arrived twice. Nothing a password would help with.
	state_mismatch: "Signing in took too long or was started twice. Try again.",
	// An assistant's request to connect, refused before the address it gave is known to be its own, so
	// the refusal comes here and not to it (`onAPIError.errorURL`). No password answers these either.
	invalid_client: NOT_CONNECTABLE,
	client_disabled: NOT_CONNECTABLE,
	unauthorized_client: NOT_CONNECTABLE,
	invalid_redirect: NOT_CONNECTABLE,
	// The words the server gives for every address it refuses, so this says nothing about any one.
	SIGN_UP_CLOSED:
		"This server takes new accounts by invitation. Ask whoever runs it to invite you.",
};

/**
 * What to tell someone whose sign-in through GitHub or another provider came back with this code.
 * Only ever words of ours, and never the `error_description` beside it: anyone can make a link, and
 * it would put their text on the sign-in page.
 */
export function signInRefusal(code: string | undefined): string | null {
	if (!code) return null;
	return Object.hasOwn(REFUSALS, code)
		? (REFUSALS[code] ?? null)
		: "That way of signing in did not work. Try again, or use your password.";
}
