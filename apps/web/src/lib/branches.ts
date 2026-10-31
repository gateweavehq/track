/** How much of the title a branch name keeps, so it stays easy to type and read. */
const MAX_SLUG = 40;

/**
 * A git branch name for an issue, such as `eng-12-fix-the-login-form`. GitHub links a pull request
 * from it to the issue, and merging the pull request closes the issue.
 */
export function branchName(key: string, title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		// Dotless i has no accent to strip.
		.replace(/ı/g, "i")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `${key.toLowerCase()}-${shorten(slug)}` : key.toLowerCase();
}

/** The slug cut after the last whole word that fits. */
function shorten(slug: string): string {
	if (slug.length <= MAX_SLUG) return slug;
	const end = slug.lastIndexOf("-", MAX_SLUG);
	return end > 0 ? slug.slice(0, end) : slug.slice(0, MAX_SLUG);
}
