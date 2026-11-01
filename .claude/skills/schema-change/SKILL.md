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
6. For what Drizzle cannot express, such as an FTS5 table, write the SQL yourself in a custom
   migration: `pnpm --filter @gateweave/track-sync-server db:generate --custom --name <name>`
   makes the empty file and its journal entry. Keep such tables out of `schema.ts`, so Drizzle
   Kit never tries to manage them, and declare them next to the code that queries them (see
   `src/search.ts`). Separate statements with `--> statement-breakpoint`, fill in existing
   data in the same migration, and add a test that undoes it and runs it again over a
   workspace with data.
7. Run `pnpm --filter @gateweave/track-sync-server test`.

### When another branch's migration lands first

Parallel branches each take the next migration number and usually the next `PROTOCOL_VERSION`,
so the one that merges second renumbers. Never rename the files or edit the journal by hand: the
migrator skips an entry whose `when` is no later than the last one a workspace applied, so a
migration moved by hand can silently never run. Regenerate it instead:

1. `git merge origin/main`. Expect conflicts in `drizzle/meta/_journal.json`, `drizzle/migrations.js`,
   a `drizzle/meta/NNNN_snapshot.json`, and often `PROTOCOL_VERSION` and `schema.ts`.
2. Resolve every conflict outside `drizzle/` first. Drizzle Kit loads `schema.ts` and the protocol
   it imports, so both must compile: keep both sides' changes, and if this branch changes
   `PROTOCOL_VERSION`, set it to main's plus one.
3. Take main's generated files, then remove this branch's own migration (keep its SQL aside if it
   is a custom migration):

   ```sh
   git checkout --theirs packages/sync-server/drizzle/meta packages/sync-server/drizzle/migrations.js
   git rm packages/sync-server/drizzle/<this branch's NNNN_name>.sql
   git add packages/sync-server/drizzle
   ```

   If this branch's snapshot has a number main lacks, `git rm` it too.
4. Regenerate this branch's migration after main's:
   `pnpm --filter @gateweave/track-sync-server db:generate --name <name>` (or `--custom`, and paste
   the SQL back). Read the new SQL: it must hold only this branch's change. Run `pnpm format`.
5. Add drop lines for both tables or columns to the migration rewind tests (`inbox.test.ts`,
   `statuses.test.ts` and the search test in `sync.test.ts`), dropping a table before any table
   it references.
6. Check the numbering, then run the tests:

   ```sh
   node scripts/check-migrations.mjs --base origin/main
   pnpm --filter @gateweave/track-sync-server test
   ```

`pnpm check` runs the same check without a base: the journal's numbering and `when` order, the
snapshot chain and `migrations.js`. CI's `migrations` job runs it against the pull request's base.

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
4. Deploys apply D1 migrations before the new code goes live (`apps/web/scripts/deploy.mjs`), for
   Gateweave Cloud and self-hosters alike. Old code still runs against the new schema until the
   deploy finishes, so say in the pull request whether it can.

## Verify

```sh
pnpm verify
```
