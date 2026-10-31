# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; `CLAUDE.md` and other tool-specific files only add to it.

## The project

Gateweave Track is an open-source, realtime issue tracker that runs entirely on Cloudflare. It is
the first product of [Gateweave](https://gateweave.com). Each workspace lives in its own Durable
Object; browsers keep a local replica in IndexedDB and sync over WebSockets. Everything ships as one
Worker.

Read [docs/architecture.md](docs/architecture.md) before changing sync, auth or storage, and
[docs/roadmap.md](docs/roadmap.md) for where the project is going.

## Repository map

| Path                   | What lives there                                                          |
| ---------------------- | ------------------------------------------------------------------------- |
| `apps/web`             | The Worker: TanStack Start UI, Better Auth, sync and MCP gateways, D1     |
| `packages/protocol`    | Wire contract: entities, mutation schemas (zod), messages. No server code |
| `packages/sync-server` | `WorkspaceDO`: SQLite storage, mutation handlers, oplog, realtime fan-out |
| `packages/sync-client` | Browser replica: IndexedDB, optimistic mutations, tab leader election     |
| `docs/`                | Architecture, roadmap, self-hosting and ecosystem notes                   |
| `scripts/`             | Repository tooling (`doctor`)                                             |
| `.claude/skills/`      | Step-by-step playbooks for recurring tasks (plain Markdown, any agent)    |
| `wrangler.jsonc`       | The Worker's config, at the root because the Deploy button reads it there |

Wrangler commands that use the build output (`deploy`, `versions upload`, `preview`) must run
from the repository root, where the build leaves its pointer next to `wrangler.jsonc`. Use
`pnpm wrangler …`, which does that.

## Commands

Requirements: Node.js 24 (see `.node-version`; 22+ works) and pnpm 12. Run from the repository
root unless noted.

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                         |
| `pnpm doctor`     | Check the local toolchain and setup, with fixes for anything missing         |
| `pnpm dev:setup`  | One-time: create `.dev.vars` and migrate the local D1 database               |
| `pnpm dev`        | Run the app on http://localhost:4710 (Workers, D1 and Durable Objects local) |
| `pnpm dev:seed`   | Fill the running app with sample people, teams and issues (`--help`)         |
| `pnpm check`      | Biome lint and format check (`pnpm format` fixes most findings)              |
| `pnpm typecheck`  | Type-check every package (regenerates Wrangler and route types first)        |
| `pnpm test`       | Run every test suite                                                         |
| `pnpm test:e2e`   | Build, then run the browser tests (Playwright, Chromium) on port 4711        |
| `pnpm test:perf`  | Build, then time a cached open and edit propagation against the budgets      |
| `pnpm build`      | Production build                                                             |
| `pnpm verify`     | Everything CI runs: check, typecheck, test, build                            |
| `pnpm run deploy` | Build, apply D1 migrations, deploy (see `docs/self-hosting.md`)              |
| `pnpm wrangler`   | The pinned Wrangler, run from the repository root                            |

Gateweave's public demo is the `demo` environment in `wrangler.jsonc`: `pnpm --filter
@gateweave/track-web deploy:demo` and `db:migrate:demo` mirror the staging scripts. Its code
(`apps/web/src/server/demo/`) must stay inert unless `TRACK_DEMO` is `"1"`; see
`docs/architecture.md`. The sample data for `pnpm dev:seed` and the demo lives there too.

Scope a command to one package with `pnpm --filter <name> <script>`, for example
`pnpm --filter @gateweave/track-sync-client test`. Run `pnpm verify` before you consider a change
done.

## Invariants

These are load-bearing. Breaking one breaks users' data or security, usually silently.

1. **The server is authoritative.** Clients predict; the Durable Object decides. Never let a
   client-supplied value bypass validation in `packages/sync-server/src/mutations.ts`.
2. **A mutation exists in three places**: its schema in `packages/protocol/src/mutations.ts`, its
   handler in `packages/sync-server/src/mutations.ts`, and its prediction in
   `packages/sync-client/src/optimistic.ts`. Change all three together, with tests. Follow
   `.claude/skills/add-mutation/SKILL.md`.
3. **The protocol is a contract.** Any breaking change to a message or entity shape bumps
   `PROTOCOL_VERSION` in `packages/protocol/src/messages.ts`. That also discards client caches.
4. **Versions are gapless and mutations are idempotent.** Every op gets the next workspace
   version; a mutation id applies once. Keep both properties when touching `log.ts` or
   `applyMutation`.
5. **Durable Object handlers stay synchronous.** Mutations run inside
   `ctx.storage.transactionSync` with Drizzle's sync API (`.get()`, `.all()`, `.run()`). Never
   `await` in the middle of a write.
6. **The Durable Object has no public route.** Only the gateways reach it, after checking D1
   membership: `apps/web/src/server/sync.ts` for browsers (Origin and session first) and
   `apps/web/src/server/mcp/index.ts` for AI agents (an OAuth token or an agent member's key
   first, never cookies). GitHub's deliveries (`apps/web/src/server/github.ts`) carry no member:
   the object checks their signature against the connection's secret before reading them.
   The unsubscribe link in an inbox email (`apps/web/src/server/unsubscribe.ts`) carries no
   session either: its token, signed with `BETTER_AUTH_SECRET`, names the member, and it can only
   turn their email off. Non-members get the same 404 or "not found" as a missing workspace. The verified member
   travels in `MEMBER_HEADER` or as the `member` argument of `mutate`, which only a gateway sets.
7. **Server code never reaches the browser bundle.** In server functions, import server modules
   dynamically inside the handler, as `apps/web/src/lib/session.ts` does.
8. **Migrations are append-only.** Generate them with Drizzle Kit and commit them. Never edit a
   migration that has been merged. Follow `.claude/skills/schema-change/SKILL.md`.
9. **Secrets stay local.** Never commit `.dev.vars` or print its contents.
10. **Admin rights are granted, never assumed.** `agent` is a role as well as `member`, so what
    only owners and admins may do is decided with `isAdminRole` from `packages/protocol`, never
    by comparing a role with `member`.

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- Validate untrusted input at the boundary with zod. Inside, trust the types.
- Prefer `#private` fields, named exports and small modules. Default exports only where a
  framework requires them.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- Generated files are not edited by hand: `routeTree.gen.ts`, `worker-configuration.d.ts`,
  `apps/web/src/server/db/auth-schema.ts` (`pnpm --filter @gateweave/track-web auth:schema`), and
  everything under `drizzle/` and `migrations/` except the hand-written `migrations.d.ts` and
  custom migrations (`drizzle-kit generate --custom`, such as `0003_issue_search.sql`).
- Dependencies are pinned to exact versions. Shared ones go in the `catalog:` of
  `pnpm-workspace.yaml`. `drizzle-orm` stays on 0.45: the 1.0 migration format does not work
  with Wrangler's D1 migrations.
- UI code copied into the repository (components, blocks, hooks) must come from an MIT or
  Apache-2.0 source, such as shadcn/ui, Magic UI or SmoothUI. Note the source and keep its
  copyright notice in a comment at the top of the file. Paid or restricted kits (Aceternity UI,
  shadcn.io blocks, shadcnstudio Pro) cannot ship in an AGPL repository.

## Testing

- Test behavior through public APIs, not internals.
- `packages/sync-server` tests run inside workerd (`@cloudflare/vitest-plugin`) against a real
  Durable Object over real WebSockets.
- `packages/sync-client` tests run in Node against the same Durable Object, hosted by Wrangler's
  local runtime behind a stand-in gateway (`test/worker`). Network, IndexedDB and tabs are real
  or close to it; see `test/harness.ts`.
- `apps/web` has unit tests in `src/` and Worker tests in `test/`. The Worker tests build the app
  and run it in workerd through Miniflare, with every outbound request failing as a deployed
  Worker's request to its own hostname does; see `test/track-worker.ts`.
- `apps/web/e2e` has browser tests: Playwright drives Chromium against the production build
  (`vite preview`, port 4711, its own empty local database), because the service worker exists
  only there. They cover what the other suites cannot: sign-up, realtime across tabs and people,
  and working offline. `pnpm test:e2e` builds (`e2e/build.mjs`, which pins `BETTER_AUTH_URL` so
  `/mcp` is on for tests that play an agent) and runs them; the first time, run
  `pnpm --filter @gateweave/track-web exec playwright install chromium`. They are not part of
  `pnpm verify`; CI runs them as the `e2e` job. Every test signs up its own user and workspace.
  Go offline with `network.goOffline()` (`e2e/network.ts`), which also closes open sockets.
  To run them in two checkouts at once, give each its own port with `TRACK_E2E_PORT` (4712 to
  4719), set for the build and for Playwright alike.
- `apps/web/perf` holds the performance budgets. Playwright (its own config, the same server on
  port 4711) fills a workspace with 2,000 issues, then times a reload from the local copy (the
  app's `track:issue-list-shown` mark) and an edit reaching a second browser, five runs each.
  `pnpm test:perf` fails when a median goes over its budget in `perf/budgets.ts`, and writes the
  numbers to the job summary. CI runs it as the `perf` job; it is not part of `pnpm verify`.
  Never loosen a budget to pass; find what got slower.
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green `check`, squash or rebase
  merged. Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps: `fix(sync-server): reject updates to deleted issues`. Explain why in the
  body.
- Fill in the pull request template. A CLA bot asks first-time contributors to sign once.
- Follow `.claude/skills/open-pull-request/SKILL.md` for the full flow.
- Pull requests leave `CHANGELOG.md` alone, so parallel branches do not conflict there. A
  maintainer adds each version's entry when releasing: merge it to `main`, then publish a GitHub
  release of that commit with the same notes. Publishing deploys Gateweave Cloud's production.

## Playbooks

Each folder in `.claude/skills/` holds a `SKILL.md` for a recurring task. They are plain Markdown,
so any agent can follow them:

| Skill               | Use it to                                                        |
| ------------------- | ---------------------------------------------------------------- |
| `add-mutation`      | Add or change a sync mutation across protocol, server and client |
| `schema-change`     | Change a D1 or Durable Object schema with a migration            |
| `run-locally`       | Start the app and check a change in a real browser               |
| `open-pull-request` | Take a change from a branch to a merged-ready pull request       |
