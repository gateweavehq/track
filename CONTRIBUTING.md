# Contributing to Tangent

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request. Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```sh
pnpm install
pnpm doctor      # checks Node, pnpm and the local setup, with fixes for anything missing
pnpm dev:setup
pnpm dev
```

See the [README](README.md) for details and [docs/architecture.md](docs/architecture.md) for how
the system fits together. Read the architecture doc before changing anything in
`packages/protocol`, `packages/sync-server` or `packages/sync-client`.

## Contributor License Agreement

Tangent is open source under the AGPL-3.0. The maintainer also offers it under other terms,
such as a hosted service and commercial licenses, and these help fund the project. So that every
contribution can be part of both, contributors sign the [CLA](CLA.md) once. You keep the
copyright to your work.

A bot asks you to sign on your first pull request. To sign, reply with the sentence it gives you.

## Before you open a pull request

```sh
pnpm verify      # Biome check, typecheck, tests and a production build: what CI runs
```

`pnpm format` fixes most Biome findings. While iterating, scope a command to one package, for
example `pnpm --filter @tangent/sync-client test`.

Fill in the pull request template: it asks how you tested the change and whether it needs a
protocol bump or a migration.

## Guidelines

- **Keep changes focused.** One pull request should cover one concern. Open an issue first for
  large features or anything that changes the sync protocol.
- **Test behavior, not implementation.** Sync-server tests drive a real Durable Object over real
  WebSockets (`packages/sync-server/test`), and sync-client tests run the client against that
  same Durable Object (`packages/sync-client/test`). Add a test for every bug fix and every new
  mutation.
- **Keep predictions in step with the server.** A new or changed mutation needs its optimistic
  version in `packages/sync-client/src/optimistic.ts` as well as its handler in
  `packages/sync-server/src/mutations.ts`.
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

## Working with AI coding agents

You are welcome to use one. [AGENTS.md](AGENTS.md) gives agents the project's commands,
invariants and conventions, and `.claude/skills/` holds step-by-step playbooks for recurring
tasks such as adding a mutation or changing a schema. You remain responsible for the change:
review it, run `pnpm verify`, and make sure you can explain it in review.

## Reporting bugs

Open an issue using the bug report form: the steps to reproduce, what you expected, and what
happened. Report security problems privately, as described in [SECURITY.md](SECURITY.md), never
in a public issue.
