---

name: run-locally
description: Start Gateweave Track locally (Workers, D1 and Durable Objects via Vite) and check a change in a real browser - sign up, create a workspace, test realtime sync across tabs, inspect IndexedDB and tab leadership. Use for UI changes and for confirming sync behavior end to end.
---

# Run Gateweave Track locally and check a change

## Start

```sh
pnpm doctor       # toolchain, setup and port check, with fixes
pnpm dev:setup    # first time only: .dev.vars + local D1 migrations
pnpm dev          # http://localhost:4710
pnpm dev:seed     # sample workspace "acme": 4 people, 3 teams, 34 issues
```

- Gateweave products use 47xx ports (site 4700, Track 4710, Agents 4720), and `pnpm dev`
  fails instead of moving when 4710 is taken. Check whether a Track dev server is already
  running and reuse it. Otherwise pick another port:
  `pnpm --filter @gateweave/track-web exec vite dev --port 4711`.
- Don't run two dev servers at once. They would share the local state in
  `apps/web/.wrangler/state`.
- Server code reloads on save. After installing a dependency, restart the server.

## Walk through the app

1. Sign in at `/login` as one of the accounts `pnpm dev:seed` prints (all share the password
   `track-demo-password`): `maya@example.com` is the owner, `sam@` an admin, `lena@` and
   `diego@` members. Pass `--url` if the server is not on port 4710.
2. Open `/acme`. The workspace runs on the sync client: the badge in the corner shows the
   connection state and the number of unsynced edits.
3. Edit, move and create issues. Changes should appear instantly and stay after a reload.
4. For an empty workspace, sign up with a new email instead. For a large one, seed another
   workspace with filler: `pnpm dev:seed --slug load --issues 5000`.

## Check sync behavior

Open the same workspace in a second tab, then run these in the browser console:

```js
// One tab holds the lock and the only connection; the others wait for it.
await navigator.locks.query();

// The local replica: one database per user and workspace.
(await indexedDB.databases()).map((d) => d.name);

// Access probe used after failed handshakes: 204 for members, 404 otherwise.
(await fetch(`/api/sync/${location.pathname.slice(1)}/snapshot`, { method: "HEAD" })).status;
```

- An edit in either tab shows in both at once. The follower's edit is sent by the leader.
- Closing the leader tab hands the connection to the other tab.
- Signing out deletes the local databases.

## Post source run events

To see runs on an issue or the Runs page, report them as the runner would. Create the source
in Settings → Sources first; the key shows once. If a run event needs its `url` kept, enter the
URL's origin in **Link origins** while creating the source — the edit form shows them read-only
and updates do not change them. Events are validated by `packages/protocol/src/sources.ts`:
they require `title` and `sentAt`, the issue field is `issue` (such as `ENG-1`) and the agent
field is `agent`:

Use the port your dev server runs on (`4710` unless you started it elsewhere), choose an existing
issue, and give every report a fresh `sentAt`:

```sh
sent_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -X POST http://localhost:4710/api/events \
  -H "authorization: Bearer gws_…" \
  -H "content-type: application/json" \
  -d "{\"kind\":\"run\",\"key\":\"fix-eng-1\",\"state\":\"running\",\"title\":\"Fix ENG-1\",\"sentAt\":\"$sent_at\",\"issue\":\"ENG-1\",\"executor\":\"local-runner\",\"agent\":\"Codex\"}"
```

A 200 means the endpoint answered, not necessarily that it created a run: check the response body.
It can carry a `reason` such as `No such issue.` instead. When accepted, the run shows live,
without a reload. Read the schema when the shape changes.

## Reset local data

Stop the dev server first. To start over, delete `apps/web/.wrangler/state` (all local users,
workspaces and workspace data) and run `pnpm dev:setup` again. Clear the browser's site data
for localhost to drop IndexedDB replicas.
