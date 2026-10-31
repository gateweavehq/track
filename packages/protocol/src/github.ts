/**
 * A webhook on GitHub, set up by an admin, that tells the workspace of pull requests and pushes.
 * Its secret is shown once, when it is made or rotated.
 */
export interface GitHubConnection {
	id: string;
	/** The member who made it. */
	createdBy: string;
	createdAt: number;
	/** When the last delivery with a valid signature arrived, and its event, if one has. */
	lastDeliveryAt: number | null;
	lastEvent: string | null;
	/**
	 * The repository it was about, such as `acme/app`. An organization's webhook hears from all its
	 * repositories, and its first delivery, a ping, names only the organization.
	 */
	lastRepository: string | null;
}

export const MAX_GITHUB_CONNECTIONS = 10;

/** GitHub events a connection acts on. It answers `ping` and ignores the rest. */
export const GITHUB_EVENTS = ["pull_request", "push"] as const;
