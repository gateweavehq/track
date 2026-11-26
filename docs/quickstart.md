# Quickstart

About N minutes from a fresh clone gets you Track on your own Cloudflare account, at a workers.dev
address, deployed from the command line, with you signed in as its first account and a workspace
that holds your first issue.

This is the shortest path: no custom domain, no sign-in provider and no email. The rest is in
[self-hosting.md](self-hosting.md).

## What you need

- A Cloudflare account on the Workers Paid plan. The Free plan gives a request too little CPU for a
  password sign-in; [self-hosting.md](self-hosting.md) has the numbers. R2 must be turned on once in
  the dashboard, under R2 Object Storage, because Track keeps attached files there.
- [Git](https://git-scm.com/downloads).
- [Node.js](https://nodejs.org) 24 (22 and later work) and [pnpm](https://pnpm.io/installation) 12.
- A browser, for signing in to Cloudflare and for Track itself.

## Steps

1. Get the code.

   ```sh
   git clone https://github.com/gateweavehq/track.git
   cd track
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Cloning into 'track'...
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Packages: +519
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved 519, reused 519, downloaded 0, added 519, done

   devDependencies:
   + @biomejs/biome 2.6.8
   + typescript 7.0.2

   Done in 33s using pnpm v12.4.2
   ```

   The counts differ a little from release to release.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   </details>

4. Deploy.

   ```sh
   pnpm run deploy
   ```

   Nothing needs setting first. The deploy builds Track, creates the database, the file bucket and
   the Durable Object classes, makes the secret that signs sessions (`BETTER_AUTH_SECRET`) and never
   shows it, and then applies the database migrations. If your account has no workers.dev
   subdomain yet, Wrangler offers to register one: say yes.

   The Worker, the database and the bucket are called `gateweave-track`, `gateweave-track` and
   `gateweave-track-files`, from `name`, `database_name` and `bucket_name` in `wrangler.jsonc`.
   To use other names, change those three before this step. The Worker's name is also the first part
   of its address.

   <details>
   <summary>Expected output</summary>

   ```text
   ...
   ✓ built in 15.39s
   Created the R2 bucket gateweave-track-files for attached files.
   ...
   Total Upload: 6929.47 KiB / gzip: 1623.92 KiB
   The following bindings need to be provisioned:
   Binding        Resource
   env.DB         D1 Database

   Provisioning DB (D1 Database)...
   Resource name found in config: gateweave-track
   🌀 Creating new D1 Database "gateweave-track"...
   ✨ DB provisioned 🎉
   🎉 Resources provisioned, continuing with deployment...
   Durable Object exports reconciliation:
     Created: RateLimiter, WorkspaceDO
   Worker Startup Time: 116 ms
   Your Worker has access to the following bindings:
   Binding                                         Resource
   env.WORKSPACE (WorkspaceDO)                     Durable Object
   env.RATE_LIMITER (RateLimiter)                  Durable Object
   env.EMAIL (unrestricted)                        Send Email
   env.DB (gateweave-track)                        D1 Database
   env.FILES (gateweave-track-files)               R2 Bucket
   env.BETTER_AUTH_SECRET ("(hidden)")             Environment Variable
   Uploaded gateweave-track (17.52 sec)
   Deployed gateweave-track triggers (2.36 sec)
     https://gateweave-track.<your-subdomain>.workers.dev
     schedule: 23 3 * * *
   Current Version ID: 0f3c1a52-7d4e-4b8a-9c61-2e5b8d7a1f34
   ...
   About to apply 18 migration(s)
   ...
   │ 0017_workspace_deletion.sql     │ ✅     │
   ```

   The address on the line after `Deployed` is yours. The migration table lists every migration
   with a tick; the last one is shown above. The deploy takes about a minute on a warm package
   cache.

   </details>

5. Open the address from the last step in your browser and choose **Create an account**. Enter a
   name, an email address and a password of at least 8 characters, then **Create account**. Track
   sends no email and asks for no confirmation, so any address will do.

   This server is open until you change it: anyone who reaches the address can make an account, and
   the first one, yours, owns the server. Do this step before you share the address. To let in only
   people you choose, see [Who may sign up](self-hosting.md#who-may-sign-up).

   <details>
   <summary>Expected output</summary>

   You are signed in at once, and the page that opens is titled **Workspaces**, with "Signed in as"
   and your address under it and "You are not in any workspace yet." below.

   </details>

6. Under **New workspace**, give it a name such as `Acme` and choose **Create workspace**. Leave
   "Start with a team and a few issues that show you around" ticked.

   <details>
   <summary>Expected output</summary>

   The workspace opens on its own address, `/acme`, with a team named after it and a short list of
   issues that show you around, the first called "Welcome to Track".

   </details>

7. Press `C`, type a title such as `My first issue`, and choose **Create issue**.

   <details>
   <summary>Expected output</summary>

   The issue appears in the team's list with a key made of the team's key and a number, and opens
   with the title you typed.

   </details>

## Next

- [self-hosting.md](self-hosting.md): your own domain, GitHub or single sign-on, email, who may sign
  up, updating and backups.
- [mcp.md](mcp.md): connect an AI agent to your Track, once `BETTER_AUTH_URL` names your address.
