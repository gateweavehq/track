---

name: schema-change
description: Change a database schema in Gateweave Track with a proper migration - the D1 database (users, sessions, workspaces, via Better Auth) or the per-workspace Durable Object SQLite database (teams, issues, oplog). Use when adding or altering tables, columns or indexes.
---

# Change a schema

Two databases, two owners. Pick the right one first.

| Data                                          | Database              | Schema file                                         | Package                        |
| --------------------------------------------- | --------------------- | --------------------------------------------------- | ------------------------------ |
| Users, sessions, workspaces, members, invites | D1                    | `apps/web/src/server/db/auth-schema.ts` (generated) | `@gateweave/track-web`         |
| Teams, issues, member replica, oplog          | Durable Object SQLite | `packages/sync-server/src/db/schema.ts`             | `@gateweave/track-sync-server` |

Migrations are append-only. Never edit or delete a migration that has been merged; write a new
one that moves the schema forward.

## Durable Object schema

1. Edit `packages/sync-server/src/db/schema.ts`.
2. Generate the migration:

   ```sh
   pnpm --filter @gateweave/track-sync-server db:generate
   ```

   This writes `drizzle/NNNN_*.sql`, updates `drizzle/meta/` and regenerates
   `drizzle/migrations.js`. Commit all of them.
3. Read the generated SQL. SQLite cannot alter some columns in place, so Drizzle may rebuild the
   table; make sure existing rows survive.
4. Migrations run in the `WorkspaceDO` constructor inside `blockConcurrencyWhile`, the first time
   each workspace wakes up after a deploy. They must be fast and must never fail on existing data.
5. If the change is visible to clients (a new entity field), update `packages/protocol` too and
   bump `PROTOCOL_VERSION` (see the `add-mutation` skill).
6. Run `pnpm --filter @gateweave/track-sync-server test`.

## D1 (Better Auth)

The D1 schema is generated from the Better Auth configuration
(`apps/web/src/server/auth/config.ts`). Don't edit `auth-schema.ts` by hand.

1. Change the Better Auth configuration, for example a plugin or `additionalFields`.
2. Regenerate the Drizzle schema, then the migration:

   ```sh
   pnpm --filter @gateweave/track-web auth:schema
   pnpm --filter @gateweave/track-web db:generate
   ```
3. Read the SQL in `apps/web/migrations/`, then apply it locally and run the app:

   ```sh
   pnpm --filter @gateweave/track-web db:migrate:local
   ```
4. Production migrations are applied with `pnpm --filter @gateweave/track-web db:migrate:remote`. Note in
   the pull request that a deploy needs it, and whether old code can run against the new schema
   during the rollout.

## Verify

```sh
pnpm verify
```
