/** What to say about a refusal from the auth endpoints, where the server's own words are not for people. */
export function authFailure(error: {
	code?: string | undefined;
	message?: string | undefined;
}): string {
	if (error.code === "SESSION_NOT_FRESH") {
		return "You signed in a while ago. Sign out and sign in again, then try this again.";
	}
	if (error.code === "INVALID_PASSWORD") return "That password is not right.";
	return error.message || "Something went wrong";
}
