# Contributing to Tangent

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request.

## Setup

```sh
pnpm install
pnpm dev:setup
pnpm dev
```

See the [README](README.md) for details and [docs/architecture.md](docs/architecture.md) for how
the system fits together. Read the architecture doc before changing anything in
`packages/protocol` or `packages/sync-server`.

## Before you open a pull request

```sh
pnpm check       # Biome lint + format (pnpm format fixes most issues)
pnpm typecheck
pnpm test
```

CI runs the same commands plus a production build.

## Guidelines

- **Keep changes focused.** One pull request should cover one concern. Open an issue first for
  large features or anything that changes the sync protocol.
- **Test behavior, not implementation.** Sync-server tests drive a real Durable Object over real
  WebSockets (`packages/sync-server/test`). Add a test for every bug fix and every new mutation.
- **Protocol changes are breaking changes.** If you change a message or entity shape in
  `packages/protocol`, bump `PROTOCOL_VERSION` and describe the migration in the pull request.
- **Schema changes need migrations.** Edit the Drizzle schema, then run `pnpm db:generate` in the
  package that owns it (`apps/web` for D1, `packages/sync-server` for Durable Objects). Commit
  the generated migration. Never edit a migration that has already been merged.
- **Match the surrounding code.** Biome enforces formatting. For everything else, follow the
  conventions of the file you are editing.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`. Add a scope when it helps, for example
`fix(sync-server): reject updates to deleted issues`.

## Reporting bugs

Open an issue that includes the steps to reproduce, what you expected, and what happened.
Security problems should be reported privately to the maintainers, not in a public issue.
