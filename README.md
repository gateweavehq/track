# Gateweave Track

Open-source, realtime issue tracking built natively on Cloudflare.

Track keeps every workspace in its own Durable Object, so edits reach everyone instantly, the
app stays fast at any size, and the whole thing deploys as a single Worker you can run on your
own Cloudflare account.

Track is the first product of [Gateweave](https://gateweave.com), a family of open-source,
Cloudflare-native business tools. See [docs/ecosystem.md](docs/ecosystem.md).

> **Status: early development.** Sync (server and client), auth, workspaces, invitations, issue
> lists, boards and the issue page work end to end. Labels and comments are next. Expect breaking
> changes.

## Highlights

- **Realtime by default.** Changes stream over WebSockets to every open client.
- **Instant and offline-ready.** The app opens from a local IndexedDB copy and shows edits
  before the server confirms them. Edits made offline are kept and sent on reconnect.
  Concurrent edits merge per field instead of overwriting each other.
- **Cloudflare-native.** Workers, Durable Objects with SQLite, and D1. No servers, containers or
  external databases.
- **One deploy.** UI, API, auth and sync ship together as one Worker.

## Tech stack

[TanStack Start](https://tanstack.com/start) · React 19 · Tailwind CSS 4 ·
[Better Auth](https://better-auth.com) · [Drizzle ORM](https://orm.drizzle.team) ·
Cloudflare Workers, Durable Objects and D1 · TypeScript 7 · Vitest · Biome

## Getting started

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
pnpm install
pnpm doctor      # checks your toolchain and setup, and explains how to fix anything missing
pnpm dev:setup   # creates apps/web/.dev.vars with a random secret, migrates the local database
pnpm dev         # http://localhost:4710
pnpm dev:seed    # in a second terminal: a sample workspace with people, teams and issues
```

The seed prints the sample accounts to sign in with. You can also sign up with any email and
password and create a workspace from scratch. To enable "Sign in with GitHub", fill in
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `apps/web/.dev.vars`.

## Scripts

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Run the app locally with Workers, D1 and Durable Objects |
| `pnpm dev:seed`  | Fill the running app with a sample workspace             |
| `pnpm doctor`    | Check the local toolchain and setup                      |
| `pnpm check`     | Lint and format check (Biome)                            |
| `pnpm format`    | Apply formatting and safe lint fixes                     |
| `pnpm typecheck` | Type-check every package                                 |
| `pnpm test`      | Run the test suites                                      |
| `pnpm build`     | Production build                                         |
| `pnpm verify`    | Everything CI runs: check, typecheck, test and build     |

## Deploying

`apps/web/wrangler.jsonc` describes two environments, each a separate Worker with its own D1
database and workspaces: production at the top level (`gateweave-track`) and `staging`
(`gateweave-track-staging`). From `apps/web`, signed in with `npx wrangler login`:

```sh
pnpm run deploy              # production: builds, then deploys
pnpm db:migrate:remote
pnpm deploy:staging          # staging: builds with `--mode staging`, then deploys
pnpm db:migrate:staging
```

The first deploy of an environment provisions its D1 database and Durable Object, so run the
migrations after it. Then set the session secret once (`openssl rand -base64 32` makes one):

```sh
npx wrangler secret put BETTER_AUTH_SECRET                  # production
npx wrangler secret put BETTER_AUTH_SECRET --env staging    # staging
```

From then on, apply migrations before deploying, so new code never meets an old schema.

Each Worker answers on its `workers.dev` address. To serve Track on your own domain, add a custom
domain to the Worker in the Cloudflare dashboard (Workers & Pages → the Worker → Settings →
Domains & Routes), or add `"routes": [{ "pattern": "track.example.com", "custom_domain": true }]`
to your copy of `wrangler.jsonc`. Auth works on any domain the Worker serves; set
`BETTER_AUTH_URL` as a secret only if you want to pin one.

## Project structure

```
apps/web               The Worker: UI, auth, sync gateway, D1 schema
packages/protocol      Wire contract shared by client and server
packages/sync-server   WorkspaceDO: storage, mutations, realtime fan-out
packages/sync-client   Browser replica: local cache, optimistic edits, one connection per browser
docs/                  Architecture, roadmap and ecosystem notes
scripts/               Repository tooling
```

Read [docs/architecture.md](docs/architecture.md) for how sync, auth and storage fit together, and
[docs/roadmap.md](docs/roadmap.md) for what comes next.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). If you work with an AI coding agent, point it at
[AGENTS.md](AGENTS.md). Report security issues privately, as described in
[SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Yiğit Tanrıverdi.

Gateweave Track is licensed under the [GNU Affero General Public License v3.0](LICENSE). You can
self-host, use and modify Track freely. If you run a modified version as a network service, you must
make your changes available to its users under the same license.

Contributions are accepted under the [Contributor License Agreement](CLA.md).
