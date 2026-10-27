# Tangent

Open-source, realtime issue tracking built natively on Cloudflare.

Tangent keeps every workspace in its own Durable Object, so edits reach everyone instantly, the
app stays fast at any size, and the whole thing deploys as a single Worker you can run on your
own Cloudflare account.

> **Status: early development.** The sync server, auth and workspaces work end to end. The client
> sync engine and the issue UI are next. Expect breaking changes.

## Highlights

- **Realtime by default.** Changes stream over WebSockets to every open client.
- **Built for offline edits.** Clients apply changes optimistically, and mutations are idempotent
  and safe to retry. Concurrent edits merge per field instead of overwriting each other.
- **Cloudflare-native.** Workers, Durable Objects with SQLite, and D1. No servers, containers or
  external databases.
- **One deploy.** UI, API, auth and sync ship together as one Worker.

## Tech stack

[TanStack Start](https://tanstack.com/start) · React 19 · Tailwind CSS 4 ·
[Better Auth](https://better-auth.com) · [Drizzle ORM](https://orm.drizzle.team) ·
Cloudflare Workers, Durable Objects and D1 · TypeScript 7 · Vitest · Biome

## Getting started

Requirements: Node.js 22+ and pnpm 12.

```sh
pnpm install
pnpm dev:setup   # creates apps/web/.dev.vars with a random secret, migrates the local database
pnpm dev         # http://localhost:3000
```

Sign up with any email and password, then create a workspace. To enable "Sign in with GitHub",
fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `apps/web/.dev.vars`.

## Scripts

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Run the app locally with Workers, D1 and Durable Objects |
| `pnpm check`     | Lint and format check (Biome)                            |
| `pnpm format`    | Apply formatting and safe lint fixes                     |
| `pnpm typecheck` | Type-check every package                                 |
| `pnpm test`      | Run the test suites                                      |
| `pnpm build`     | Production build                                         |

## Deploying

From `apps/web`, signed in with `npx wrangler login`:

```sh
pnpm run deploy                          # builds, then deploys; D1 and the Durable Object are provisioned
npx wrangler secret put BETTER_AUTH_SECRET
pnpm db:migrate:remote
```

## Project structure

```
apps/web               The Worker: UI, auth, sync gateway, D1 schema
packages/protocol      Wire contract shared by client and server
packages/sync-server   WorkspaceDO: storage, mutations, realtime fan-out
docs/                  Architecture and design notes
```

Read [docs/architecture.md](docs/architecture.md) for how sync, auth and storage fit together.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You can self-host, use and modify Tangent
freely. If you run a modified version as a network service, you must make your changes available
to its users under the same license.
