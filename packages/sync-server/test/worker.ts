import { WorkspaceDO as Workspace } from "../src";

/** The test Worker's GitHub App secret, as the app's Worker reads its setting. */
export const GITHUB_APP_SECRET = "github-app-test-secret";

export class WorkspaceDO extends Workspace {
	protected override githubAppSecret(): string | null {
		return GITHUB_APP_SECRET;
	}
}
