# Roadmap

Where Gateweave Track is going, in order. Dates are deliberately absent; each phase ships when its
"done when" holds. For the wider Gateweave product family, see [ecosystem.md](ecosystem.md).

## Done

- **Sync server.** One Durable Object per workspace, a gapless oplog, idempotent mutations and
  field-level merging of concurrent edits.
- **Auth and workspaces.** Better Auth with organizations, with membership changes pushed to each
  workspace's Durable Object.
- **Client sync engine.** An IndexedDB replica per user and workspace, optimistic mutations that
  survive reloads and offline periods, and one connection per browser shared by all tabs.
- **Issue lists and detail.** Team and "My issues" lists grouped by status, an issue page that
  saves as you type, a command palette, and keyboard shortcuts for every common action.
- **Boards and manual ordering.** A board view next to each list. Issues are reordered and moved
  between statuses by drag and drop or from the keyboard, with fractional indexes.
- **Teams, members and invitations.** Settings pages to rename teams and change their keys,
  invitation links, role changes and removal. A removed member loses access at once, and their
  browser forgets the workspace.
- **Installable app.** A web app manifest and icons, so Track installs as an app on desktop and
  mobile.
- **Starting offline.** A service worker serves the app shell when there is no connection, and
  the workspace opens from the device's copy. An installed app starts on the workspace used last.
- **Labels.** Workspace-wide labels with colors, added and removed as conflict-free set
  operations, picked when creating an issue, shown on lists and boards, used to filter them (in
  the URL, so a filtered view can be shared), managed in settings, and available to agents over
  MCP.
- **MCP server.** AI agents connect to `/mcp`, sign in through OAuth with the person's approval,
  and list workspaces, search, read, create and update issues through the same mutations people
  use.
- **Comments and activity.** A thread on every issue, edited by its author and moderated by
  admins, next to a history of who changed what, written by the server and merged so quick edits
  read as one change. Agents read and add comments over MCP.
- **Email.** Optional, through Cloudflare Email Service: password reset, verified addresses, and
  invitations sent by email from admins who verified their address. Where email is on, joining a
  workspace requires a verified address, so an invitation link on its own is no longer enough.
  Self-hosters can run without it.
- **Self-hosting.** A "Deploy to Cloudflare" button, tested from a fresh copy through Workers
  Builds to a working app, and `pnpm run deploy` for the command line. Both apply D1 migrations
  before the new code goes live. [self-hosting.md](self-hosting.md) covers domains, agents,
  GitHub sign-in, email and updating.
- **End-to-end tests.** Playwright drives Chromium against the production build: sign-up,
  realtime across tabs and people, and working offline, in CI on every pull request.
- **Public repository.** The `main` ruleset is enforced and private vulnerability reporting is on.
- **Public demo.** [track-demo.gateweave.com](https://track-demo.gateweave.com) gives each
  visitor a private workspace of sample data in one click, deleted a day later.
- **v0.1.0.** The first release, with a [changelog](../CHANGELOG.md) covering every version.
- **Performance budgets.** CI times a reload of a 2,000-issue workspace from the local copy and
  an edit reaching a second browser, and fails when a median goes over its budget.
- **Full-text search.** The command palette searches keys, titles, descriptions and comments in
  the local copy; each workspace's database keeps an FTS5 index for MCP. Shipped in v0.2.0.
- **Agent members and webhooks.** Agents that work on their own join a workspace under their own
  name and connect over MCP with a key, and signed webhooks tell them about changes as they
  happen. Shipped in v0.3.0.
- **Proposals.** An admin chooses which kinds of change each agent member only proposes, such as
  closing issues or assigning them, and people accept or dismiss them on the issue. Shipped in
  v0.4.0; v0.5.0 added a workspace-wide list of open proposals, and webhook events for them.
- **Projects.** Groups of issues across teams toward a goal, with a lead, a status, a target date
  and progress. They have a page, a list, a picker on every issue and a place in the command
  palette, and agents set them over MCP. Shipped in v0.5.0.
- **Cycles.** A team can work in fixed runs of one to four weeks. The workspace dates them,
  completes them at midnight in the team's time zone and moves unfinished issues on; each has
  its progress and a burn-up, filters know the current and next cycle, and agents plan into them
  over MCP. Shipped in v0.8.0.

## Next: launch

- Show HN. The technical write-up it links to is published:
  [How Track syncs](https://gateweave.com/blog/how-track-syncs), on how a Durable Object per
  workspace, an oplog and a local replica make a fast, offline-capable app on serverless
  infrastructure.

## After launch

- **Switching kit**: what someone moving from another tracker needs on their first day.
  - A guided start: a new workspace can begin with a team and issues that show Track by doing.
  - Import from Linear, GitHub Issues and CSV, and export to CSV and JSON.
  - Markdown in descriptions and comments, with images and attachments.
  - Sub-issues and relations (blocks, duplicate of, related).
  - Start dates, due dates and estimates.
  - Saved views, and table, calendar and timeline layouts.
- Notifications and an inbox.
- GitHub integration: link pull requests and close issues from commits.
- An AI triage agent that labels, deduplicates and routes new issues through the same mutations
  people use (see [ecosystem.md](ecosystem.md#agents-are-members)). It runs in Gateweave Agents,
  on the agent members and webhooks above.
