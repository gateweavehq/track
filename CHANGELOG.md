# Changelog

Notable changes to Gateweave Track, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/track/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

## [0.13.1] - 2026-10-31

Dialogs stay within a short window. Updating a self-hosted copy needs nothing: no migration, no
new setting and no protocol change.

### Fixed

- A dialog taller than the window, such as a new issue with a long description or a webhook with
  many events, scrolls inside itself, so its title and its buttons stay in reach. ([#97], [#98])

## [0.13.0] - 2026-10-31

The MCP server's `get_workspace` says who is calling, so an agent can find the issues assigned to
it. Updating a self-hosted copy needs nothing: no migration, no new setting and no protocol
change. ([#95])

### Added

- `get_workspace` names the caller as `you`: their member id, name and role in the workspace.
  Issues assigned to them carry that id as their assignee. Gateweave Agents' ready-made "Work on
  Track issues" reads it with an agent member's key, to start a run for each issue assigned to
  that agent. ([#95])

## [0.12.0] - 2026-10-31

Mention people in descriptions and comments, and hear when an issue you are assigned is due.
Updating a self-hosted copy applies a migration in each workspace's database, which runs on its
own; there is no D1 migration and no new setting. The protocol goes to version 15, so open tabs
reload and sync again. ([#93])

### Added

- @-mentions. Typing `@` in a description, a comment or the new-issue dialog offers the
  workspace's members, people first, and picking one mentions them. Someone mentioned is
  subscribed to the issue, unless they unsubscribed before, and hears of it in their inbox, once
  per comment; editing a text tells only the people it adds. Mentions of agents and of oneself
  tell nobody, and a mention inside code is text. Agents over MCP mention people with the same
  Markdown, `[@Name](mention:<member id>)`, which the app shows with the member's current
  name. ([#93])
- Due-date reminders. On the day an open issue is due, from 09:00 in its team's time zone (the
  one its cycles follow, or UTC), Track tells its assignee in their inbox, once per due date.
  ([#93])
- Mentions and due dates in Settings, Notifications. Both are emailed until you choose
  otherwise, and someone who turns mentions off is neither subscribed nor told by one. ([#93])

## [0.11.0] - 2026-10-31

Inbox news you leave unread can follow you by email, and you choose what reaches your inbox and
your email. Updating a self-hosted copy applies a migration in each workspace's database, which
runs on its own; there is no D1 migration, no new setting and no protocol change. Email follows
`EMAIL_FROM` as before. ([#91])

### Added

- Notification settings. Settings, Notifications lets each person choose, per workspace, where
  each kind of news goes: being assigned or unassigned, comments, status changes and agents'
  proposals reach the inbox and email, the inbox alone, or nowhere. Being assigned and comments
  are emailed until you choose otherwise. News turned off stays out of the inbox, and you stay
  subscribed to the issue. ([#91])
- Inbox email. News you want by email that stays unread for ten minutes is emailed, with that
  of other issues, at most once an hour per workspace. Reading, archiving or snoozing it in Track
  first keeps it out of your email. Email goes only to verified addresses, and each one has a
  link that turns it off without signing in, which mail clients offer as one-click unsubscribe
  when Track is served over HTTPS. ([#91])

## [0.10.0] - 2026-10-31

GitHub: pull requests and commits that name an issue link to it and move it along. Also display
options in saved views. Updating a self-hosted copy applies two migrations in each workspace's
database, which run on their own; there is no D1 migration and no new setting. The protocol goes
to version 14, so open tabs reload and sync again. ([#88], [#89])

### Added

- GitHub connections. An admin adds one in Settings, GitHub, and sets it as a webhook on a
  repository or an organization. Pull requests link the issues their branch, title or
  description names, and the issue page lists them with their state. A draft moves its issues to
  In Progress and an open pull request to In Review. A merge moves the issues it fixes, named by
  its branch or after "Fixes", "Closes" or "Resolves", to Done, as does a commit to the default
  branch that says so. Track never moves an issue back, nor out of Done or Canceled, and each
  move's activity links the pull request or commit. The issue page copies a branch name for the
  issue, the inbox and webhooks name GitHub as the actor, and MCP's `get_issue` lists an issue's
  pull requests. The public demo takes no deliveries. ([#89])
- Display options. A Display menu groups the list and the board by status, priority, assignee,
  project or nothing, orders them by hand, priority, due date, last update or creation, and
  picks the properties rows and cards show. The options live in the page's URL and in saved
  views, so everyone opening a view sees the same page. Dragging an issue into another group
  sets that field. ([#88])

### Changed

- The table's columns and sort follow the page's URL and saved views instead of one browser's
  storage, so columns hidden before this version show again. ([#88])

## [0.9.0] - 2026-10-31

An inbox of your own: people hear of assignments, comments, status changes and agents' proposals
on the issues they follow. Updating a self-hosted copy applies two migrations in each workspace's
database, which run on their own; there is no D1 migration. The protocol goes to version 12, so
open tabs reload and sync again. ([#86])

### Added

- Subscriptions and an inbox. Filing, commenting on or being assigned an issue subscribes a
  person, and anyone can subscribe or unsubscribe from the issue page; existing workspaces
  subscribe the creators, assignees and commenters of their issues when they update. Subscribers
  hear of comments, status changes and agents' proposals, and the assignee hears of being
  assigned. The Inbox page keeps one row per issue with its latest news and unread count, to read,
  snooze or archive, and news brings a snoozed or archived item back. Opening an issue reads it.
  The sidebar and the installed app's icon show the unread count. Nobody hears of their own
  changes, imports tell no one, and agents have no inbox: webhooks tell them. Each person's
  subscriptions and inbox reach only their own browsers. ([#86])

### Changed

- The public demo and `pnpm dev:seed` plan a few Engineering issues into its current cycle. ([#85])

## [0.8.0] - 2026-10-31

Cycles: a team can work in fixed runs of one to four weeks, and Track moves them on by itself.
Also webhook events for relations, and importing Track's own JSON export. Updating a self-hosted
copy applies a migration in each workspace's database, which runs on its own; there is no D1
migration. The protocol goes to version 11, so open tabs reload and sync again. ([#82])

### Added

- Cycles. An admin turns them on for a team, with a length of one to four weeks, the day the next
  one starts and the time zone its days follow. The workspace keeps two cycles ahead, completes
  each at midnight after its last day and moves its unfinished issues to the next one, as Track.
  Issues are planned into a cycle from their page, the new-issue dialog or the table. A team's
  cycles page lists the current, upcoming and completed ones with their progress, and each cycle
  has a page with its dates, progress in issues and points, a burn-up and its issues. Filters and
  saved views can follow the current or next cycle. MCP's `get_workspace` lists open cycles, and
  `search_issues`, `create_issue` and `update_issue` take `cycle` as `"current"`, `"next"` or a
  number. Webhook events for the moves Track makes carry an actor of type `system`. ([#82])
- Webhook events for relations: `relation.created` and `relation.deleted`, with both issues and
  the relation. New webhooks leave them off until chosen. ([#78])
- Settings, Import reads Track's own JSON export as well as CSV, so a workspace or a team can move
  to another workspace, such as from a self-hosted copy to Gateweave Cloud. Issues keep their
  comments, parents, labels, projects and relations, and the file's teams can be kept. Repeating
  an import skips what is already there. ([#81])

### Changed

- The JSON export includes cycles. ([#82])

## [0.7.1] - 2026-10-30

Gets v0.7.0 to production. Updating a self-hosted copy needs nothing beyond what v0.7.0 asks.

### Fixed

- `pnpm run deploy` no longer stops when the Cloudflare API token may not manage R2. If the
  bucket for attached files already exists, as when it was made by hand, the deploy goes on with
  a warning; if it is missing, Cloudflare refuses the deploy and says so. ([#79])

## [0.7.0] - 2026-10-30

Everything a team moving from another tracker needs on its first day: dates and estimates,
sub-issues and relations, Markdown with attached files, filters and saved views, calendar, table
and timeline layouts, and imports from CSV, GitHub and Linear. Updating a self-hosted copy applies
migrations in each workspace's database, which run on their own; there is no D1 migration this
time. Attached files need R2: turn it on in the Cloudflare dashboard before updating, and
`pnpm run deploy` creates the bucket, or delete the `r2_buckets` lines from `wrangler.jsonc` to
run without attachments. ([#68], [#69])

### Added

- Start dates, due dates and estimates in points on issues. Lists and boards show the due date,
  in red once an open issue is overdue, and the issue page sets them (D and E). MCP's
  `create_issue` and `update_issue` take `start_date`, `due_date` and `estimate`. ([#63])
- Sub-issues: an issue can have a parent in any team, shown above its title, and lists its
  sub-issues with their progress under the description. Deleting a parent keeps its sub-issues as
  top-level issues. MCP takes and returns `parent`, and `get_issue` returns `subIssues`. ([#64])
- Relations between issues in any teams: blocks, duplicate of and related. The issue page lists
  them by kind, lists and boards mark a blocked issue, and an open duplicate offers "Close as
  duplicate". MCP has `link_issues` and `unlink_issues`. Relations send no webhook events yet.
  ([#66])
- Descriptions and comments are GitHub-flavored Markdown, and files of up to 25 MB can be pasted,
  dropped or picked into them. Files are kept in R2 and served only to members of the workspace.
  Images from other sites show as links, so opening an issue tells no one who read it. ([#68])
- Three more layouts for pages of issues: a calendar by due date, where dragging an issue to a day
  sets its due date ([#67]); a table with a column per property, editing in place, sorting and a
  choice of columns ([#73]); and a timeline from start to due date, where dragging a bar moves its
  dates ([#74]).
- One Filter menu for status, priority, assignee, project, labels, team and due date. The filters
  in force show as chips and live in the URL, and an issue created on a filtered page takes them,
  so it shows up there. ([#75])
- Saved views: filters and a layout under a name in the sidebar, shared with the workspace or
  personal. Changes on a view's page are saved into it or as a new view. Personal views are hidden
  from others in the app but, like everything in a workspace, are in each member's local copy.
  ([#76])
- Import issues in Settings > Import from a CSV file (Track's own export, or another tracker's by
  common column names), from GitHub Issues or from Linear, with their original creation dates. A
  GitHub token or Linear key goes from the browser to GitHub or Linear only. Running an import
  again skips what it already brought in. ([#70], [#71])
- Export a workspace or one team as CSV or JSON, in Settings > Export or from the command palette.
  ([#65])
- A new workspace starts with a team and a few issues that show you around, unless that box is
  unticked, and an empty workspace offers the same. ([#61])
- MCP: `create_project` and `update_project`. ([#62])

### Changed

- The sync protocol is at version 10, for the new fields and entities. Open tabs fetch their
  workspace again after the update. ([#63], [#64], [#66], [#76])
- `issue.create` and `comment.create` take an optional `createdAt`, which only admins may send and
  the server clamps to now. ([#70])

## [0.6.0] - 2026-10-30

Webhooks name each issue's labels. Updating a self-hosted copy needs no migration and no new
setting.

### Added

- Webhooks: each issue in an issue, comment or proposal event carries `labels`, a list of
  `{ id, name }` in the order of `labelIds`, with the names as of the event. A receiver can act on
  a label by its name instead of looking up its id. `labelIds` is unchanged. ([#56])

## [0.5.0] - 2026-10-29

Projects group issues from any team toward a goal, and what agents propose has a page of its own.
Updating a self-hosted copy applies a migration in each workspace's database, which runs on its
own; there is no D1 migration this time.

### Added

- Projects. A project groups issues from any team toward a goal, with a description, a status
  (planned, started, paused, completed or canceled), a lead, a target date and its progress: the
  issues done out of all that are not canceled. Projects have a list and a page with their issues
  as a list or a board, every issue has a Project property, and the command palette goes to them,
  creates them and sets them. People create and edit projects, admins delete them, and an admin
  can have an agent member only propose project changes. ([#53])
- MCP: `create_issue`, `update_issue` and `search_issues` take a `project`, by name or id, and
  `get_workspace` lists the projects. ([#53])
- A Proposals page lists the workspace's open proposals by issue, with a count in the sidebar, a
  filter by agent kept in the URL, and keys to move between them (J and K), accept (A) and dismiss
  (D). ([#52])
- Webhook events for proposals: `proposal.created`, `proposal.updated`, `proposal.accepted` and
  `proposal.dismissed`. An agent's own webhook is sent a person's decision on what it proposed,
  and not its own proposals. A new webhook leaves them off until they are chosen. ([#51])

### Changed

- The sync protocol is at version 6, for projects. Open tabs fetch their workspace again after
  the update. ([#53])

### Fixed

- A tab left open on an older version no longer keeps a tab opened after an update on
  "Loading…". Tabs now pick the one that holds the connection among tabs of the same version.
  ([#54])

## [0.4.0] - 2026-10-29

People stay in control of what agents do: an admin chooses which kinds of change each agent member
only proposes, and people accept or dismiss them. Updating a self-hosted copy applies a migration
in each workspace's database, which runs on its own; there is no D1 migration this time.

### Added

- Proposals. Under Settings, Agents, an admin picks for each agent the kinds of change it only
  proposes: title, description, status, closing (as Done or Canceled), priority, assignee and
  labels. The server holds those back, even on a new issue the agent creates, and shows them on
  the issue under "Proposed by agents" with Accept and Dismiss. Accepting makes the change as the
  person who accepted it, and the history notes which agent proposed it. An agent has one open
  proposal per field and issue, and agents never decide on proposals, their own included. An
  agent proposes nothing until an admin sets it up, so existing agents work as before. ([#49])
- MCP: `create_issue` and `update_issue` return what they proposed under `proposed`, so an
  agent knows the change waits for a person, and `get_issue` lists an issue's open proposals.
  ([#49])

### Changed

- The sync protocol is at version 5, for proposals. Open tabs fetch their workspace again after
  the update. ([#49])

## [0.3.0] - 2026-10-28

Agents that work on their own: they join a workspace under their own name, and webhooks tell them
about changes as they happen. Updating a self-hosted copy applies a new D1 migration (`pnpm run
deploy` does it) and a migration in each workspace's database, which runs on its own.

### Added

- Agent members. An admin creates one under Settings, Agents for an AI agent that works on its
  own, such as one that triages new issues. It joins the workspace with the new `agent` role,
  connects to MCP with a key instead of signing in, and reaches that one workspace only. It can do
  what members do and nothing only admins can, and everyone sees its changes as its own. ([#45])
- Webhooks. Admins add them under Settings, Webhooks: each change (an issue created, changed or
  deleted, a comment added, edited or deleted) is posted to a URL, signed per
  [Standard Webhooks](https://www.standardwebhooks.com), and retried for about 17 hours while the
  receiver fails. A webhook can be limited to one team, and one made for an agent is not sent the
  agent's own changes. Each workspace's Durable Object sends them, so there is no new binding to
  set up. ([#46])

### Changed

- The sync protocol is at version 4, for the new role. Open tabs fetch their workspace again
  after the update. ([#45])

## [0.2.0] - 2026-10-28

### Added

- Full-text search. The command palette (Ctrl+K) finds issues by words in their key, title,
  description or comments, offline and as you type, and shows where a description or comment
  matched. Typing an issue's key, such as `ENG-12`, puts that issue first. ([#42])
- Each workspace's database keeps a full-text index of its issues, which MCP's `search_issues`
  uses. A self-hosted copy builds the index for each workspace the first time it opens after the
  update, so there is nothing to run. ([#43])

### Changed

- `search_issues` matches the start of words in any field and returns the best matches first,
  where it used to match any part of the title. "auth" still finds "authentication", but
  "thentication" no longer does. ([#43])

### Fixed

- On the public demo, a returning visitor goes straight back to their workspace. ([#41])
- The demo counts new workspaces per network, so one IPv6 address can't get around the limit,
  and allows more of them. ([#39])

## [0.1.0] - 2026-10-28

The first release. It brings together everything from the alphas below: realtime sync with a
copy of each workspace on the device, offline use, issues with boards, labels, comments and
history, invitations and roles, email, an MCP server for AI agents, and self-hosting with one
deploy. Try it at [track-demo.gateweave.com](https://track-demo.gateweave.com).

Changes since 0.1.0-alpha.13:

### Added

- This changelog. Each release's GitHub notes match its entry here. ([#35])
- The README links the public demo. ([#37])

### Fixed

- `pnpm deploy:demo` built the top-level Worker instead of the demo's, because
  `apps/web/.env.demo` was ignored by Git. A test now checks every environment build. ([#36])

## [0.1.0-alpha.13] - 2026-10-28

### Added

- Track can run as a public demo, where each visitor gets a private sample workspace that is
  deleted a day later. It is a separate deployment, the `demo` environment in `wrangler.jsonc`,
  and the code does nothing where `TRACK_DEMO` is not `"1"`. Set `TRACK_DEMO=1` in `.dev.vars`
  to try it locally. ([#34])
- Performance budgets in CI: opening a 2,000-issue workspace from the local copy (1.5 s) and an
  edit reaching another person (100 ms). Run them with `pnpm test:perf`. ([#33])

### Changed

- Creating workspaces is limited to 10 a minute per client, since each one is a Durable Object.
  ([#34])
- `pnpm dev:seed` and the demo build the sample workspace from the same module. ([#34])

## [0.1.0-alpha.12] - 2026-10-28

### Security

- Sign-in, sign-up, password reset, invitation and OAuth limits are counted in a Durable Object
  per client address, so they hold across every isolate and location. Each also has an hourly
  allowance: sign-in attempts are held to 60 an hour per address. ([#32])
- Any one address gets at most 5 emails at once and 10 a day, whoever asks for them. ([#32])

Self-hosters: the deploy creates the new `RateLimiter` Durable Object on its own.

## [0.1.0-alpha.11] - 2026-10-28

### Added

- Self-hosting in one step: the "Deploy to Cloudflare" button works, and `pnpm run deploy`
  builds, applies D1 migrations and deploys, creating the database and session secret on a
  first run. A new guide, [docs/self-hosting.md](docs/self-hosting.md). ([#30])
- `pnpm wrangler …` runs the pinned Wrangler from the right directory. ([#30])
- End-to-end tests with Playwright: sign-up, realtime across tabs and people, working offline and
  signing out. Run them with `pnpm test:e2e`. ([#29])

### Changed

- `wrangler.jsonc` and `.dev.vars` live at the repository root. Contributors run
  `pnpm dev:setup` once to move their `.dev.vars`. ([#30])

## [0.1.0-alpha.10] - 2026-10-28

### Added

- Track starts with no connection. A service worker keeps the app's files, the workspace opens
  from the copy on your device, and edits made offline are sent once the server is reachable.
  An installed app starts on the workspace you used last. ([#28])

### Changed

- Signing out forgets the device's copies of your workspaces. ([#28])

### Fixed

- The Worker no longer logs an error on every cold start. ([#27])

## [0.1.0-alpha.9] - 2026-10-28

### Added

- Verified email addresses. When email is on, new accounts get a verification link, and joining
  a workspace takes a verified address. ([#26])
- The MCP `create_team` tool, for workspace admins. Reconnect your MCP client to see it. ([#25])

## [0.1.0-alpha.8] - 2026-10-28

### Added

- Email through Cloudflare Email Service, on once `EMAIL_FROM` is set: password reset, and
  invitations by email from admins with a verified address. ([#24])

## [0.1.0-alpha.7] - 2026-10-28

### Security

- Rate limiting is on in the deployed Worker. Better Auth enabled its limiter only when
  `NODE_ENV` was `production`, which a Worker never sets, so sign-in and password-reset attempts
  were unlimited. ([#23])

## [0.1.0-alpha.6] - 2026-10-28

### Added

- Pick labels when creating an issue, and filter lists and boards by label. The filter is kept
  in the URL. ([#21])

## [0.1.0-alpha.5] - 2026-10-28

### Fixed

- MCP tool results can gain fields without breaking agents that connected before an update.
  Agents connected before this release need to reconnect once. ([#20])

## [0.1.0-alpha.4] - 2026-10-28

### Added

- Comments and activity history on every issue. ([#19])
- MCP: `get_issue` returns comments, and `add_comment` lets agents comment as you. ([#19])

### Changed

- Protocol version 3: clients re-sync once after updating. ([#19])

## [0.1.0-alpha.3] - 2026-10-27

### Fixed

- MCP requests with a token failed with error 1101, because the server fetched its own signing
  keys over the network. Bad tokens now get a 401 instead of a 500. ([#18])

## [0.1.0-alpha.2] - 2026-10-27

### Added

- Workspace-wide labels with colors, on the issue page (`L`), lists and boards, and in
  Settings › Labels. ([#17])
- MCP: agents can create labels, label issues and search by label. ([#17])

### Changed

- Protocol version 2: open tabs reload and re-sync once. ([#17])

## [0.1.0-alpha.1] - 2026-10-27

The first pre-release.

### Added

- Realtime sync: one Durable Object per workspace, a local IndexedDB replica, optimistic edits
  that survive reloads and offline periods, and field-level merging of concurrent edits.
- Accounts and workspaces with Better Auth: roles, invitation links and member management.
- Issue lists, boards with drag and drop, the issue page, a command palette and keyboard
  shortcuts.
- Installable as an app.
- An MCP server at `/mcp`: AI agents sign in with your approval, then search, read, create and
  update issues. ([#15])

[0.13.1]: https://github.com/gateweavehq/track/releases/tag/v0.13.1
[0.13.0]: https://github.com/gateweavehq/track/releases/tag/v0.13.0
[0.12.0]: https://github.com/gateweavehq/track/releases/tag/v0.12.0
[0.11.0]: https://github.com/gateweavehq/track/releases/tag/v0.11.0
[0.10.0]: https://github.com/gateweavehq/track/releases/tag/v0.10.0
[0.9.0]: https://github.com/gateweavehq/track/releases/tag/v0.9.0
[0.8.0]: https://github.com/gateweavehq/track/releases/tag/v0.8.0
[0.7.1]: https://github.com/gateweavehq/track/releases/tag/v0.7.1
[0.7.0]: https://github.com/gateweavehq/track/releases/tag/v0.7.0
[0.6.0]: https://github.com/gateweavehq/track/releases/tag/v0.6.0
[0.5.0]: https://github.com/gateweavehq/track/releases/tag/v0.5.0
[0.4.0]: https://github.com/gateweavehq/track/releases/tag/v0.4.0
[0.3.0]: https://github.com/gateweavehq/track/releases/tag/v0.3.0
[0.2.0]: https://github.com/gateweavehq/track/releases/tag/v0.2.0
[0.1.0]: https://github.com/gateweavehq/track/releases/tag/v0.1.0
[0.1.0-alpha.13]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.13
[0.1.0-alpha.12]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.12
[0.1.0-alpha.11]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.11
[0.1.0-alpha.10]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.10
[0.1.0-alpha.9]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.9
[0.1.0-alpha.8]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/gateweavehq/track/releases/tag/v0.1.0-alpha.1
[#15]: https://github.com/gateweavehq/track/pull/15
[#17]: https://github.com/gateweavehq/track/pull/17
[#18]: https://github.com/gateweavehq/track/pull/18
[#19]: https://github.com/gateweavehq/track/pull/19
[#20]: https://github.com/gateweavehq/track/pull/20
[#21]: https://github.com/gateweavehq/track/pull/21
[#23]: https://github.com/gateweavehq/track/pull/23
[#24]: https://github.com/gateweavehq/track/pull/24
[#25]: https://github.com/gateweavehq/track/pull/25
[#26]: https://github.com/gateweavehq/track/pull/26
[#27]: https://github.com/gateweavehq/track/pull/27
[#28]: https://github.com/gateweavehq/track/pull/28
[#29]: https://github.com/gateweavehq/track/pull/29
[#30]: https://github.com/gateweavehq/track/pull/30
[#32]: https://github.com/gateweavehq/track/pull/32
[#33]: https://github.com/gateweavehq/track/pull/33
[#34]: https://github.com/gateweavehq/track/pull/34
[#35]: https://github.com/gateweavehq/track/pull/35
[#36]: https://github.com/gateweavehq/track/pull/36
[#37]: https://github.com/gateweavehq/track/pull/37
[#39]: https://github.com/gateweavehq/track/pull/39
[#41]: https://github.com/gateweavehq/track/pull/41
[#42]: https://github.com/gateweavehq/track/pull/42
[#43]: https://github.com/gateweavehq/track/pull/43
[#45]: https://github.com/gateweavehq/track/pull/45
[#46]: https://github.com/gateweavehq/track/pull/46
[#49]: https://github.com/gateweavehq/track/pull/49
[#51]: https://github.com/gateweavehq/track/pull/51
[#52]: https://github.com/gateweavehq/track/pull/52
[#53]: https://github.com/gateweavehq/track/pull/53
[#54]: https://github.com/gateweavehq/track/pull/54
[#56]: https://github.com/gateweavehq/track/pull/56
[#61]: https://github.com/gateweavehq/track/pull/61
[#62]: https://github.com/gateweavehq/track/pull/62
[#63]: https://github.com/gateweavehq/track/pull/63
[#64]: https://github.com/gateweavehq/track/pull/64
[#65]: https://github.com/gateweavehq/track/pull/65
[#66]: https://github.com/gateweavehq/track/pull/66
[#67]: https://github.com/gateweavehq/track/pull/67
[#68]: https://github.com/gateweavehq/track/pull/68
[#69]: https://github.com/gateweavehq/track/pull/69
[#70]: https://github.com/gateweavehq/track/pull/70
[#71]: https://github.com/gateweavehq/track/pull/71
[#73]: https://github.com/gateweavehq/track/pull/73
[#74]: https://github.com/gateweavehq/track/pull/74
[#75]: https://github.com/gateweavehq/track/pull/75
[#76]: https://github.com/gateweavehq/track/pull/76
[#78]: https://github.com/gateweavehq/track/pull/78
[#79]: https://github.com/gateweavehq/track/pull/79
[#81]: https://github.com/gateweavehq/track/pull/81
[#82]: https://github.com/gateweavehq/track/pull/82
[#85]: https://github.com/gateweavehq/track/pull/85
[#86]: https://github.com/gateweavehq/track/pull/86
[#88]: https://github.com/gateweavehq/track/pull/88
[#89]: https://github.com/gateweavehq/track/pull/89
[#91]: https://github.com/gateweavehq/track/pull/91
[#93]: https://github.com/gateweavehq/track/pull/93
[#95]: https://github.com/gateweavehq/track/pull/95
[#97]: https://github.com/gateweavehq/track/pull/97
[#98]: https://github.com/gateweavehq/track/pull/98
