# Roadmap

Where Tangent is going, in order. Dates are deliberately absent; each phase ships when its "done
when" holds. For the wider Gateweave product family, see [ecosystem.md](ecosystem.md).

## Done

- **Sync server.** One Durable Object per workspace, a gapless oplog, idempotent mutations and
  field-level merging of concurrent edits.
- **Auth and workspaces.** Better Auth with organizations, with membership changes pushed to each
  workspace's Durable Object.
- **Client sync engine.** An IndexedDB replica per user and workspace, optimistic mutations that
  survive reloads and offline periods, and one connection per browser shared by all tabs.

## Next: a usable issue tracker

- Issue list and board per team, grouped by status, with drag-and-drop ordering (fractional
  indexes).
- Issue detail: title, description, status, priority, assignee, and keyboard shortcuts for each.
- A command palette and keyboard-first navigation throughout.
- Team management and member invitations.
- Labels, comments and an activity history, as new entities and mutations.

**Done when** a small team can run its week in Tangent without falling back to another tool.

## Launch readiness

- Email through Cloudflare Email Routing and Email Sending: invitations, password reset,
  notifications.
- A verified one-click "Deploy to Cloudflare" and a self-hosting guide.
- A public demo workspace.
- End-to-end tests with Playwright: real IndexedDB, several tabs, going offline and back.
- Performance budgets, measured in CI: opening a large workspace from cache, and the time for an
  edit to reach another client.

**Done when** someone who has never seen the project can deploy it to their own Cloudflare
account in minutes and invite their team.

## Launch

- Make the repository public, with a release and a changelog.
- Show HN, plus a technical write-up of the sync engine: how a Durable Object per workspace, an
  oplog and a local replica make a fast, offline-capable app on serverless infrastructure.

## After launch

- Full-text search inside each workspace's database.
- Notifications and an inbox.
- Projects and cycles.
- GitHub integration: link pull requests and close issues from commits.
- An AI triage agent that labels, deduplicates and routes new issues through the same mutations
  people use (see [ecosystem.md](ecosystem.md#agents-are-members)).
