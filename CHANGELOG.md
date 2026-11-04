# Changelog

Notable changes to Gateweave Track, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/track/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

## [0.26.2] - 2026-11-04

Signing out at a provider could leave someone signed in to Track. Updating a self-hosted copy needs no migration and
no new setting, and the protocol stays at version 25. ([#196])

### Fixed

- **A provider's logout could be lost.** If the provider stopped waiting for the answer, Workers cancelled the
  request and the session stayed, which happened on Gateweave Cloud. A logout that has arrived is now seen through.
  When Track cannot fetch the provider's keys at that moment it answers 503 rather than 400, so that a provider can
  try again, and nothing ends until the token has been checked. ([#196])

## [0.26.1] - 2026-11-04

Better Auth 1.7.16, a security release, so anyone running a copy should update. Updating a self-hosted
copy needs no migration and no new setting, and the protocol stays at version 25. ([#194])

### Security

- **Better Auth 1.7.16.** Email verification and email-change links worked for an account other than the
  one they were issued to. Generic OAuth profiles are now bound to the ID token's subject, which signing
  in through an OpenID Connect provider rests on. ([#194])

## [0.26.0] - 2026-11-04

Every signed-in page carried the session's token in its HTML, and signing in with GitHub stored
GitHub's token where nothing used it, so anyone running a copy should update. GitHub's automation
also now moves an issue only when a pull request is about it. Updating a self-hosted copy applies one
D1 migration, which deletes those stored GitHub tokens, and needs no new setting; the protocol stays
at version 25. ([#190], [#191], [#192])

### Security

- Every signed-in page carried the session's token in its HTML, where a saved page or anything that
  keeps a copy of the document would have it too. The cookie is `HttpOnly` to keep it from there, and
  no page reads it, so pages no longer get it. Better Auth's `/get-session` still answers a script
  with it, so this keeps the token out of documents, not out of reach of a script already running in
  the page. ([#190])
- Signing in with GitHub stored GitHub's access token, unencrypted, in `account`. Nothing read it:
  Track never acts for someone there, and its GitHub integration makes an exchange of its own. Track
  now keeps none of them, and a migration deletes the ones already stored. ([#192])

### Changed

- **A pull request that only mentions an issue in its description links it and no longer moves it.**
  An issue named to say it was out of scope used to go to In Review with no work done on it. The
  branch name, the title and a closing word such as "Fixes ENG-12" still move an issue, and a closing
  word added by a later edit moves it when the edit arrives. ([#191])

## [0.25.0] - 2026-11-04

Track can sign people in through an OpenID Connect provider, and a password can no longer reach a
page's URL, so anyone running a copy should update. Updating a self-hosted copy applies one D1
migration, which only adds a column, and needs no new setting; the protocol stays at version 25.
([#183], [#184], [#187], [#188])

### Security

- Pressed before the page's script had run, on a slow connection for example, the submit button on
  the sign-in and password reset pages made the browser send the form itself, with the password in
  the URL: in the address bar, the history and any log of requests. These buttons now stay disabled
  until there is a script. ([#188])

### Added

- Sign in through any OpenID Connect provider, such as Gateweave ID, Pocket ID or Keycloak, with
  `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, and `OIDC_PROVIDER_NAME` for the button.
  Signing out at the provider ends the sessions it started. Without them nothing changes. See
  docs/self-hosting.md. ([#187])
- `scripts/update-copy.mjs` updates a copy made with the Deploy button, which `git pull` cannot:
  that copy shares no history with this repository. See docs/self-hosting.md. ([#183], [#184])

### Changed

- A refused sign-in through GitHub comes back to the sign-in page with an explanation, not to
  Better Auth's error page. ([#187])

## [0.24.0] - 2026-11-04

A new workspace now learns how to move in from another tracker, and dependencies are up to date.
Updating a self-hosted copy needs no migration and no new setting; the protocol stays at version
25. ([#179], [#180])

### Added

- The guided start has two more issues: bringing issues from another tracker (Settings, Import,
  from Jira's CSV export, a Linear team, a GitHub repository, CSV or another workspace's JSON
  export), and linking pull requests from GitHub (Settings, GitHub). ([#179])

### Changed

- Dependencies are updated. postal-mime, which reads intake email, goes to 4.2.0, with fixes for
  how it reads malformed messages, and wrangler to 4.156.0. ([#180])

## [0.23.0] - 2026-11-02

Teams can move from Jira, and moving from Linear keeps more. Updating a self-hosted copy needs no
migration and no new setting; the protocol stays at version 25. ([#174], [#175], [#176], [#177])

### Added

- Settings, Import reads Jira's CSV export (Filters, Export, Export Excel CSV (all fields)):
  every label, comments with who wrote them, Jira's dates, parents named by issue id, story
  points, issue types other than Task as labels, and the status category of a team's own status
  names. Descriptions and comments in Jira's wiki markup become Markdown: headings, lists, code
  with its language, tables, links, quotes and inline styles. Attachments stay in Jira, and each
  one shown in the text becomes a note naming its file. ([#176], [#177])
- A Linear import brings the relations between the team's issues (blocks, duplicate, related)
  and the team's projects with their description and document, status, lead, target date and
  updates. ([#177])

### Fixed

- In local development (`pnpm dev`), the optional settings that `.dev.vars.example` says to
  uncomment, such as the Turnstile keys, `INTAKE_EMAIL_DOMAIN` and the GitHub App's, now take
  effect. Before, the list of settings it loaded stopped at `EMAIL_FROM`. ([#174])

## [0.22.0] - 2026-11-02

Long lists and tables are much faster, issues with very long comment threads keep working, text
with invisible broken characters is cleaned or refused, and intake email is safe from a slow
header. Updating a self-hosted copy applies a migration in each workspace's database, which runs
on its own; there is no D1 migration and no new setting. The protocol stays at version 25.
([#168], [#169], [#171], [#172], [#173])

### Security

- A crafted header in a message to a team's intake email address could make the Worker spend
  CPU time that grew with the square of its length. postal-mime, which reads those messages, is
  updated to 4.0.8 (GHSA-f2hq-32vh-53cc). ([#173])

### Fixed

- An issue whose comments added up past about 10 MB could take no more comments, and its newest
  ones were not found by search. Such an issue's comments are now indexed apart, so it takes new
  comments and all of them stay searchable. The migration moves only issues past 1 MiB of
  comments. ([#169])
- A picker that had just closed could take the next click or Escape meant for what lay under it,
  such as the next row's priority picker in a table. Menus and pickers now leave the page as soon
  as they close. ([#172])

### Changed

- Issue lists draw only the rows near the screen. Changing 2,000 issues at once now shows in about
  135 ms instead of 1,160, and opening a workspace from the device's copy in about 340 ms instead
  of 1,100. Rows are measured, so the list holds at any font size, and screen readers hear each
  row's place in the list. When a change is refused because its issue is gone, the message says
  so apart from other refusals. ([#171])
- The issue table also draws only the rows near the screen, measured so they hold at any font
  size. J/K and the arrow keys move between its rows as in a list, and its header row stays at the
  top as it scrolls. ([#172])
- Text with NUL characters or lone halves of an emoji's character pair is refused by the server,
  since it confused search or came back silently changed. The app, request forms, intake email,
  the guided start, the importer and GitHub titles clean such text instead, so people do not run
  into errors. Text already stored stays as it is. ([#168])

## [0.21.1] - 2026-11-02

Open tabs lose their connection when their session ends, exports handle large archives, and bulk
edit follow-ups. Updating a self-hosted copy needs no migration and no new setting; the protocol
stays at version 25. ([#161], [#163], [#164], [#166])

### Security

- A tab's live connection now closes when its session ends: signing out, revoking sessions,
  resetting the password or deleting the account. A connection whose session has expired closes
  too. Before, an open tab kept syncing until the workspace restarted. The tab then reconnects
  if the person is still signed in, or asks them to sign in again. ([#164])

### Fixed

- Exports page through large archives instead of fetching them in one answer, and when an export
  fails it says why: offline, signed out, no access, or a server error. Issues restored while an
  export runs are no longer left out. Tabs still on v0.21.0 keep getting the answer they expect,
  or an error rather than a short file; that answer is sized by its bytes, so archives of many
  small rows still fit and only ones that are really too big are refused. ([#163], [#166])
- Bulk edit: changes made offline and refused after a reload are summed up in one message instead
  of one per issue, collapsing a group no longer unpicks its issues, refusals are grouped by
  reason, and a tab that has stopped syncing says so instead of calling the change not valid.
  ([#161])

## [0.21.0] - 2026-11-02

Archived issues are whole again whenever there is a connection: their page, exports and imports.
Updating a self-hosted copy needs no migration and no new setting; the protocol stays at version
25. ([#159])

### Added

- An archived issue's page loads the whole issue from the server while online: its description,
  labels, people, dates, comments, history, proposals and pull requests, read-only, with Restore
  as before. Offline it keeps the short view and says the rest needs a connection. ([#159])
- Two read-only routes beside the sync snapshot, behind the same membership checks: one issue
  with everything that belongs to it, and a workspace's or a team's archived issues. ([#159])

### Changed

- Exports fetch archived issues from the server, so the CSV fills in their cells and the JSON
  lists them whole, with their comments and history. Offline, an export that includes archived
  issues stops and offers to leave them out, and a JSON made that way says how many it left out.
  ([#159])
- The JSON import brings archived issues along, with their comments and relations, and archives
  each one once it is in. Slim rows from v0.20 exports still stay behind, with a note. ([#159])

## [0.20.1] - 2026-11-02

Bulk edit stays quick on large selections, and two follow-ups to v0.20.0's security fixes.
Updating a self-hosted copy needs no migration and no new setting; the protocol stays at
version 25. ([#156], [#157])

### Fixed

- Changing several hundred issues at once froze the tab for many seconds. The changes now go out
  as one batch and the page redraws once per frame: about 680 issues show their change in under
  half a second. A failed batch says in one message how many issues were left as they were,
  instead of one message per issue. The bar's menus and Ctrl/Cmd+A no longer open where they do
  not apply, and issues hidden by a filter leave the selection. ([#157])
- Mail to a request's reply address is now parsed only after its address is found, so mail to
  made-up reply addresses costs nothing. When attaching files, every refused file is reported,
  including first tries made offline, and each one can be saved again from the device's copy.
  ([#156])

## [0.20.0] - 2026-11-02

Pick several issues and change them at once, in lists, tables and on the board; archived issues
weigh much less on each device; and two security fixes. Updating a self-hosted copy needs no
migration and no new setting. The protocol goes to version 25, so open tabs reload and every
browser starts again from a fresh copy of its workspaces. ([#148], [#149], [#150], [#151],
[#153], [#154])

### Security

- An attached file's upload belongs to whoever attached it. The browser links a file before its
  upload finishes, so another member could see its id; the first upload to an id now wins
  atomically, and anyone else's upload to it is refused instead of being taken as done. ([#150])
- Leaving a workspace, and deleting a user, now tell the workspace at once, so the person's open
  tabs lose access as they do when an admin removes them. Mail to a request's reply address is
  checked against the request and its sender before it counts against any limit or stores any
  attachment. ([#153])

### Added

- Bulk edit: pick issues by a checkbox, X, Shift or Ctrl/Cmd+A in lists, tables and on the board,
  then set their status, priority, assignee, labels, project or cycle, archive the closed ones,
  or delete them, from a bar at the bottom. Each change is the same one a single issue's menu
  makes, so history, the inbox and webhooks see it as usual. ([#148], [#151], [#154])
- Track has its own icon: an issue in progress, on the dark tile of the new Gateweave mark.
  ([#152])

### Changed

- Archived issues stay in each browser's copy only as a slim row: key, title, status, team,
  project, cycle, parent and estimate. Lists, boards, the archive page, links, progress and search
  by key or title work from it, offline too; an archived issue's description, comments and
  history need a connection. JSON exports list archived issues apart, with what is known of them.
  ([#149])

## [0.19.0] - 2026-11-01

Admins can connect GitHub by installing a GitHub App, files can be attached while offline, and a
deployment can cap each workspace's attached files. Updating a self-hosted copy applies a D1
migration (`pnpm run deploy` applies it before the new code goes live) and a migration in each
workspace's database, which runs on its own. The protocol stays at version 24. The new settings
are optional: `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` and
`GITHUB_APP_WEBHOOK_SECRET` turn on the GitHub App, and `ATTACHMENT_QUOTA_MB` caps attached
files per workspace (see `docs/self-hosting.md`). ([#131], [#138], [#141])

### Added

- A GitHub App that admins install from Settings, GitHub, on the repositories they choose, next
  to adding a webhook by hand. An installation connects to a workspace only once GitHub vouches
  for it and the person controls the account it is on: an active admin of the organization, or
  the owner of the personal account. The app needs the Organization › Members: Read permission
  for that check. Webhooks keep working, for self-hosters without an app. ([#141])
- Files attached while offline, or whose upload fails on the network, wait in the browser and
  upload when the connection returns. Until then the text marks them as waiting, and images show
  from the device's copy. A file waits for the person who attached it, even across an expired
  session. ([#131])
- `ATTACHMENT_QUOTA_MB` caps what each workspace keeps in attached files. Uploads past it get a
  clear refusal, and emailed requests still come in, without the attachments that do not fit.
  Unset, storage is unlimited, as before. ([#138], [#145])

## [0.18.0] - 2026-11-01

Teams can take requests into an intake, from a public form and by email; projects have updates,
a health and insights; templates can make issues on a schedule. Updating a self-hosted copy
applies five migrations in each workspace's database, which run on their own; there is no D1
migration. The new settings are optional: `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` open
teams' request forms, and `INTAKE_EMAIL_DOMAIN`, with Email Routing, turns on their intake email
addresses (see `docs/self-hosting.md`). The protocol goes to version 24, so open tabs reload and
sync again. ([#109], [#114], [#118], [#125], [#128], [#133])

### Added

- Team intake: requests wait on a team's intake page until a person accepts them into the
  workflow or declines them with a reply. Members file them in the app and agents over MCP
  (`triage_request`). ([#109])
- A public request form per team, behind Turnstile, that admins turn on and share, and an intake
  email address per team, through Email Routing. Attachments of emailed requests are kept with
  the request. Both are rate limited. ([#109], [#126])
- Whoever filed a request through the form or by email is emailed the decision, and members who
  follow it hear of it in their inbox. A reply to the decision email becomes a comment on the
  request, without the text it quotes. ([#118], [#133])
- An agent's decision on a request becomes a proposal, whatever it is set to propose: only
  people decide on requests. Accepting it makes the decision as the person, with the agent's
  drafted reply. ([#125])
- Project updates: a health (on track, at risk, off track) and a note, kept as the project's
  history, shown on the projects page, sent to webhooks and available over MCP
  (`post_project_update`, `list_project_updates`). ([#114])
- Insights per project, across its teams, and filters by label and assignee on team and project
  insights. Over MCP, `get_insights` gives an agent a team's or a project's numbers. ([#116],
  [#117], [#119])
- Recurring issues: a template can make its issue every 1 to 99 days, weeks or months, at
  midnight in the time zone its schedule names. ([#128])
- Over MCP, `get_issue` names what filed a request or wrote a reply on its own: Request form,
  Email, GitHub or Track. ([#134])

### Changed

- Lists, boards and views no longer go through archived issues on every change, so a workspace
  with many of them stays as quick to edit. ([#124])
- Settings tabs fit in one row on a desktop, and menus keep clear of the window's edges and are
  at least as wide as what opened them. ([#129], [#130])

### Fixed

- In Node 22, a client whose reconnect was refused stayed "connecting" instead of finding out
  why. ([#123])

## [0.17.0] - 2026-11-01

Teams can keep issue templates, and each team has an insights page. Updating a self-hosted copy
applies a migration in each workspace's database, which runs on its own; there is no D1
migration and no new setting. The protocol goes to version 19, so open tabs reload and sync
again. ([#112])

### Added

- Issue templates per team, kept by any member under Settings, Templates: a name and the title,
  description, priority, assignee and labels a new issue starts with, up to 50 per team. Start
  an issue from one in the create dialog's Template menu or with "Create issue from …" in the
  command palette. ([#112])
- Over MCP, `get_workspace` lists each team's templates, and `create_issue` takes one by name.
  Fields given in the call win over the template's. ([#112])
- Team insights, from a button in the team header: open, created and closed counts and the
  median cycle time over the last 4, 12 or 26 weeks, issues created and closed by week in the
  team's time zone, and open issues by status, assignee and label. ([#111])
- A JSON import that keeps the file's teams brings along their own statuses, such as
  "Ready for QA", instead of moving those issues to the first status of the same category.
  ([#110])

### Fixed

- An issue's Labels menu offers "Create label" when no label matches what was typed, including
  in a workspace with no labels yet. ([#112])

## [0.16.0] - 2026-11-01

Teams can have Track archive closed issues and close stale ones on its own. Updating a self-hosted
copy applies a migration in each workspace's database, which runs on its own; there is no D1
migration and no new setting. The protocol goes to version 18, so open tabs reload and sync
again. ([#107])

### Added

- Team automations, set by admins in the team settings: archive completed and canceled issues,
  and cancel backlog and unstarted ones, once no one has touched them for 1 to 24 months. Each is
  off until turned on, and the settings say how many issues the first run would change. ([#107])
- Track applies them about once a day, with an entry in each issue's history and an
  `issue.updated` webhook, but nothing in anyone's inbox. A team's archive page says when issues
  arrive on their own. ([#107])
- Over MCP, `get_workspace` gives each team's `archiveAfterMonths` and `closeAfterMonths`. ([#107])

### Changed

- The teams settings wrap a team's actions below its name on narrow screens. ([#107])

## [0.15.0] - 2026-11-01

Closed issues can be archived out of lists and boards. Updating a self-hosted copy applies a
migration in each workspace's database, which runs on its own; there is no D1 migration and no
new setting. The protocol goes to version 17, so open tabs reload and sync again. ([#105])

### Added

- Archive a completed or canceled issue from its page, and it leaves the lists and boards of its
  team, project, cycle and saved views, and My issues. Search, its page, its history and the
  progress of its project, cycle and parent keep it. ([#105])
- Each team has an archive page, linked from the team page once something is in it and from the
  command palette, where archived issues can be restored. Reopening an archived issue restores
  it too. ([#105])
- Over MCP, `search_issues` takes `archived`, every issue says whether it is archived, and
  `update_issue` archives or restores an issue. Webhooks send it as `issue.updated`, with
  `archivedAt`. ([#105])

## [0.14.1] - 2026-11-01

Webhook payloads name the issue's assignee. Updating a self-hosted copy needs no migration and no
new setting. ([#103])

### Added

- Issues in webhook payloads carry `assignee`: the member's id and their name as of the event, or
  null when no one is assigned, so a receiver can show who `assigneeId` is. ([#103])

## [0.14.0] - 2026-11-01

Each team has its own workflow statuses. Updating a self-hosted copy applies two migrations in
each workspace's database, which run on their own and give every existing team the six statuses
it had; there is no D1 migration and no new setting. The protocol goes to version 16, so open tabs
reload and sync again. ([#100])

### Added

- Workflow statuses per team. Under Settings, Teams, Statuses, an admin adds statuses, renames,
  recolors and reorders them, and removes one by moving its issues to another. Every status is
  in one of five categories (backlog, unstarted, started, completed and canceled), and the
  category decides what it means: completed and canceled statuses close an issue, and completed
  ones count as done in cycles, projects and sub-issues. A team keeps at least one completed
  status. ([#100])
- Pages that show several teams' issues, such as My issues, give statuses that share a key one
  column or group, so every team's built-in statuses line up. ([#100])
- Webhook payloads name the issue's status as its team does (`statusName`) and say its category
  (`statusCategory`). ([#100])
- Over MCP, a status is named by its key or its name. `get_workspace` lists each team's
  statuses in order, and issues come back with `statusName`. ([#100])

### Changed

- GitHub moves an issue to the status of the old key while the team has it in the same
  category, and otherwise to the team's first status of that category. ([#100])
- Imports match a status by name in the team, then take the team's first status of the same
  category. JSON exports carry the teams' statuses. ([#100])
- A new issue without a status gets its team's first status, Backlog unless the team changed it.
  ([#100])

### Fixed

- A picker opened just as another one closes, such as a row's priority right after its status,
  stays open instead of closing again. ([#102])

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

[0.26.2]: https://github.com/gateweavehq/track/releases/tag/v0.26.2
[0.26.1]: https://github.com/gateweavehq/track/releases/tag/v0.26.1
[0.26.0]: https://github.com/gateweavehq/track/releases/tag/v0.26.0
[0.25.0]: https://github.com/gateweavehq/track/releases/tag/v0.25.0
[0.24.0]: https://github.com/gateweavehq/track/releases/tag/v0.24.0
[0.23.0]: https://github.com/gateweavehq/track/releases/tag/v0.23.0
[0.22.0]: https://github.com/gateweavehq/track/releases/tag/v0.22.0
[0.21.1]: https://github.com/gateweavehq/track/releases/tag/v0.21.1
[0.21.0]: https://github.com/gateweavehq/track/releases/tag/v0.21.0
[0.20.1]: https://github.com/gateweavehq/track/releases/tag/v0.20.1
[0.20.0]: https://github.com/gateweavehq/track/releases/tag/v0.20.0
[0.19.0]: https://github.com/gateweavehq/track/releases/tag/v0.19.0
[0.18.0]: https://github.com/gateweavehq/track/releases/tag/v0.18.0
[0.17.0]: https://github.com/gateweavehq/track/releases/tag/v0.17.0
[0.16.0]: https://github.com/gateweavehq/track/releases/tag/v0.16.0
[0.15.0]: https://github.com/gateweavehq/track/releases/tag/v0.15.0
[0.14.1]: https://github.com/gateweavehq/track/releases/tag/v0.14.1
[0.14.0]: https://github.com/gateweavehq/track/releases/tag/v0.14.0
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
[#100]: https://github.com/gateweavehq/track/pull/100
[#102]: https://github.com/gateweavehq/track/pull/102
[#103]: https://github.com/gateweavehq/track/pull/103
[#105]: https://github.com/gateweavehq/track/pull/105
[#107]: https://github.com/gateweavehq/track/pull/107
[#110]: https://github.com/gateweavehq/track/pull/110
[#111]: https://github.com/gateweavehq/track/pull/111
[#112]: https://github.com/gateweavehq/track/pull/112
[#109]: https://github.com/gateweavehq/track/pull/109
[#114]: https://github.com/gateweavehq/track/pull/114
[#116]: https://github.com/gateweavehq/track/pull/116
[#117]: https://github.com/gateweavehq/track/pull/117
[#118]: https://github.com/gateweavehq/track/pull/118
[#119]: https://github.com/gateweavehq/track/pull/119
[#123]: https://github.com/gateweavehq/track/pull/123
[#124]: https://github.com/gateweavehq/track/pull/124
[#125]: https://github.com/gateweavehq/track/pull/125
[#126]: https://github.com/gateweavehq/track/pull/126
[#128]: https://github.com/gateweavehq/track/pull/128
[#129]: https://github.com/gateweavehq/track/pull/129
[#130]: https://github.com/gateweavehq/track/pull/130
[#133]: https://github.com/gateweavehq/track/pull/133
[#134]: https://github.com/gateweavehq/track/pull/134
[#131]: https://github.com/gateweavehq/track/pull/131
[#138]: https://github.com/gateweavehq/track/pull/138
[#141]: https://github.com/gateweavehq/track/pull/141
[#145]: https://github.com/gateweavehq/track/pull/145
[#148]: https://github.com/gateweavehq/track/pull/148
[#149]: https://github.com/gateweavehq/track/pull/149
[#150]: https://github.com/gateweavehq/track/pull/150
[#151]: https://github.com/gateweavehq/track/pull/151
[#152]: https://github.com/gateweavehq/track/pull/152
[#153]: https://github.com/gateweavehq/track/pull/153
[#154]: https://github.com/gateweavehq/track/pull/154
[#156]: https://github.com/gateweavehq/track/pull/156
[#157]: https://github.com/gateweavehq/track/pull/157
[#159]: https://github.com/gateweavehq/track/pull/159
[#163]: https://github.com/gateweavehq/track/pull/163
[#164]: https://github.com/gateweavehq/track/pull/164
[#161]: https://github.com/gateweavehq/track/pull/161
[#166]: https://github.com/gateweavehq/track/pull/166
[#168]: https://github.com/gateweavehq/track/pull/168
[#169]: https://github.com/gateweavehq/track/pull/169
[#171]: https://github.com/gateweavehq/track/pull/171
[#172]: https://github.com/gateweavehq/track/pull/172
[#173]: https://github.com/gateweavehq/track/pull/173
[#174]: https://github.com/gateweavehq/track/pull/174
[#175]: https://github.com/gateweavehq/track/pull/175
[#176]: https://github.com/gateweavehq/track/pull/176
[#177]: https://github.com/gateweavehq/track/pull/177
[#179]: https://github.com/gateweavehq/track/pull/179
[#180]: https://github.com/gateweavehq/track/pull/180
[#183]: https://github.com/gateweavehq/track/pull/183
[#184]: https://github.com/gateweavehq/track/pull/184
[#187]: https://github.com/gateweavehq/track/pull/187
[#188]: https://github.com/gateweavehq/track/pull/188
[#190]: https://github.com/gateweavehq/track/pull/190
[#191]: https://github.com/gateweavehq/track/pull/191
[#192]: https://github.com/gateweavehq/track/pull/192
[#194]: https://github.com/gateweavehq/track/pull/194
[#196]: https://github.com/gateweavehq/track/pull/196
