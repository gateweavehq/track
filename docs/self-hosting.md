# Self-hosting

Track runs on your own Cloudflare account as one Worker, with a D1 database for accounts and the
list of workspaces, and a Durable Object for each workspace. A free Cloudflare account is enough
to start. Email to any address needs the Workers Paid plan; Track works without email.

There are two ways to deploy: the button, which also sets up deploys on every push, or the
command line.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/track)

The button copies this repository to your GitHub or GitLab account and connects the copy to
Workers Builds, so every push to its main branch deploys. On the form:

- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database**: choose **Create new**.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- Leave the build and deploy commands as they are. The deploy command applies the database
  migrations before the new code goes live.

When the build finishes, open the Worker's address, create an account and then a workspace.
Anyone who can reach the address can sign up and create workspaces of their own; a workspace is
only visible to its members.

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. Previews get their own Durable Objects, so their workspaces are separate, but they share
the D1 database, and so the accounts, unless you bind another one in the Worker's
[Preview settings](https://developers.cloudflare.com/workers/previews/configuration/). Turn them
off under Settings › Build › Branch control if you don't need them.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/track.git
cd track
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version Track pins, from the repository root. The Worker and
its database are named `gateweave-track`; to use other names, change `name` and `database_name`
in `wrangler.jsonc` before the first deploy.

The first deploy creates the D1 database and the Durable Object namespace, generates
`BETTER_AUTH_SECRET` (it is never shown), then applies the migrations. Every later
`pnpm run deploy` builds, applies new migrations, and only then deploys.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard
(Workers & Pages › your Worker › Settings › Variables and Secrets) or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

| Name                   | What it does                                                               |
| ---------------------- | -------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Signs sessions. Required.                                                  |
| `BETTER_AUTH_URL`      | The address people use, such as `https://track.example.com`. Turns on MCP. |
| `GITHUB_CLIENT_ID`     | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.               |
| `GITHUB_CLIENT_SECRET` | The client secret of the same GitHub OAuth app.                            |
| `EMAIL_FROM`           | Turns on email, such as `Gateweave Track <track@example.com>`.             |

### Your own domain

In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "track.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
Sign-in works on any address the Worker serves.

### AI agents (MCP)

Agents connect to `/mcp` and sign in through OAuth. Their tokens are bound to one address, so the
endpoint is only on once `BETTER_AUTH_URL` names it, for example `https://track.example.com`.
Agents then connect to `https://track.example.com/mcp`.

An agent that works on its own, such as one that triages new issues, gets a member of its own
instead: an admin creates it under Settings, Agents, and gives its MCP client the key shown there,
as `Authorization: Bearer <key>`. It needs nothing else to be set up.

### Webhooks

Webhooks need no setup either: each workspace's Durable Object sends them itself, with no Queue
or other binding. Admins add them under Settings, Webhooks. They must use `https`, except when
the app itself runs on plain `http`, and cannot point at the app's own host.

### Sign in with GitHub

Create a [GitHub OAuth app](https://github.com/settings/developers) with the callback URL
`https://track.example.com/api/auth/callback/github` (your address), then set
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Email

Without email, admins share invitation links themselves and nobody can reset a forgotten
password. To turn it on:

1. Onboard a domain to [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/):
   `pnpm wrangler email sending enable example.com`. Sending to any address needs the Workers Paid
   plan.
2. Set `EMAIL_FROM` to a sender on that domain, such as `Gateweave Track <track@example.com>`.

Track then sends password resets, address verification and invitations. With email on, joining
a workspace requires a verified address.

## The public demo

Gateweave's own demo (a private sandbox per visitor, deleted after a day) is a separate
deployment, the `demo` environment in `wrangler.jsonc`. You do not need it: it is off unless the
`TRACK_DEMO` variable is `"1"`, which only that environment sets. See
[the architecture notes](architecture.md#the-public-demo).
## Updating

**Command line:** `git pull`, `pnpm install`, `pnpm run deploy`.

**Button:** your copy does not follow this repository on its own. Pull new releases into it and
push; Workers Builds deploys the push and applies the migrations:

```sh
git remote add upstream https://github.com/gateweavehq/track.git   # once
git pull upstream main
git push
```

The button writes your database's ID into `wrangler.jsonc`. Keep your version of those lines if
a pull ever conflicts there.

Track is in early development. Read [CHANGELOG.md](../CHANGELOG.md) before updating, as some
releases change how things work.
