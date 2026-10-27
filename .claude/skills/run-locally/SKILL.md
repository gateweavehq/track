---

name: run-locally
description: Start Tangent locally (Workers, D1 and Durable Objects via Vite) and check a change in a real browser - sign up, create a workspace, test realtime sync across tabs, inspect IndexedDB and tab leadership. Use for UI changes and for confirming sync behavior end to end.
---

# Run Tangent locally and check a change

## Start

```sh
pnpm doctor       # toolchain, setup and port check, with fixes
pnpm dev:setup    # first time only: .dev.vars + local D1 migrations
pnpm dev          # http://localhost:3000
```

- If port 3000 is taken, check whether a Tangent dev server is already running and reuse it.
  Otherwise pick another port: `pnpm --filter @tangent/web exec vite dev --port 3001`.
- Don't run two dev servers at once. They would share the local state in
  `apps/web/.wrangler/state`.
- Server code reloads on save. After installing a dependency, restart the server.

## Walk through the app

1. Open `/login`, choose "Create an account" and sign up with any email and password. Use a
   unique email per run; local data persists between runs.
2. Create a workspace. Its page runs on the sync client: the badge in the corner shows the
   connection state and the number of unsynced edits.
3. Create a team, then issues. They should appear instantly and stay after a reload.

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

## Reset local data

Stop the dev server first. To start over, delete `apps/web/.wrangler/state` (all local users,
workspaces and workspace data) and run `pnpm dev:setup` again. Clear the browser's site data
for localhost to drop IndexedDB replicas.
