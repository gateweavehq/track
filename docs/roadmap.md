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
- **Email.** Optional, through Cloudflare Email Service: password reset, and invitations sent by
  email from admins who verified their address. Self-hosters can run without it.

## Next: launch readiness

- Verified email addresses, and `requireEmailVerificationOnInvitation`, so that an invitation link
  on its own is no longer enough to join a workspace.
- Opening the app with no connection. A loaded workspace already keeps working offline; starting
  one offline needs a service worker that serves the app shell, and workspace loaders that fall
  back to what the device already knows when the session and membership checks cannot reach the
  server.
- A verified one-click "Deploy to Cloudflare" and a self-hosting guide.
- A public demo workspace, filled by the seed script (`pnpm dev:seed`) and reset every night.
- End-to-end tests with Playwright: real IndexedDB, several tabs, going offline and back.
- Performance budgets, measured in CI: opening a large workspace from cache, and the time for an
  edit to reach another client.

**Done when** someone who has never seen the project can deploy it to their own Cloudflare
account in minutes and invite their team.

## Launch

- Make the repository public, with a release and a changelog. Then check that the `main` ruleset
  is enforced (on GitHub's free organization plan, rulesets apply only to public repositories)
  and turn on private vulnerability reporting.
- Show HN, plus a technical write-up of the sync engine: how a Durable Object per workspace, an
  oplog and a local replica make a fast, offline-capable app on serverless infrastructure.

## After launch

- Full-text search inside each workspace's database.
- Notifications and an inbox.
- Projects and cycles.
- GitHub integration: link pull requests and close issues from commits.
- An AI triage agent that labels, deduplicates and routes new issues through the same mutations
  people use (see [ecosystem.md](ecosystem.md#agents-are-members)).
