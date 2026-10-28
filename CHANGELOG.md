# Changelog

Notable changes to Gateweave Track, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/track/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

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
