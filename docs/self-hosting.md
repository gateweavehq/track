# Self-hosting

Track runs on your own Cloudflare account as one Worker, with a D1 database for accounts and the
list of workspaces, a Durable Object for each workspace, and an R2 bucket for attached files.

Use the Workers Paid plan. On the Free plan a request gets
[10 ms of CPU](https://developers.cloudflare.com/workers/platform/limits/), and checking a password
takes far more: 85 ms in the one sign-in measured on a deployed Worker. Track has not been run on
the Free plan, so how often a sign-in would fail there is not known. Email to any address needs the
Paid plan too; Track works without email.

R2 has a free tier, but it is turned on once per account, in the dashboard under R2 Object
Storage, before anything can use it. To run without attachments instead, delete the
`r2_buckets` lines from `wrangler.jsonc` before deploying; uploads then answer that they are not
set up.

There are two ways to deploy: the button, which also sets up deploys on every push, or the
command line.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/track)

The button copies this repository to your GitHub or GitLab account and connects the copy to
Workers Builds, so every push to its main branch deploys. On the form:

- **Git account** is the first field, the account the copy goes to. If nothing is connected yet,
  connect GitHub or GitLab there.
- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database** and **R2 bucket**: choose **Create new**.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- Leave the build and deploy commands as they are. The deploy command applies the database
  migrations before the new code goes live.

When the build finishes, open the Worker's address, create an account and then a workspace.
Anyone who can reach the address can sign up and create workspaces of their own; a workspace is
only visible to its members.

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. A Preview gets none of the Worker's bindings or secrets, so its address only says that it
is not set up, and it cannot reach your data. To make Previews work, create another D1 database and
apply the migrations to it, name it, a bucket and the Durable Objects under `previews` in
`wrangler.jsonc` as [Cloudflare's
guide](https://developers.cloudflare.com/workers/previews/resources/) shows, and give them a secret
of their own with `pnpm wrangler preview base-config secret put BETTER_AUTH_SECRET`. If you don't
need them, untick **Enable Preview builds** on the form, or turn them off later under Settings ›
Build › Branch control.

**Dependabot.** The copy brings this repository's `.github/dependabot.yml`, so Dependabot opens a
pull request on it within minutes, and weekly after that. You don't need them: a release brings
updates that were tested together, and what you merge can conflict with the next update. Delete the
file unless you want them, and close what it opened.

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

The first deploy creates the D1 database, the R2 bucket and the Durable Object namespace, generates
`BETTER_AUTH_SECRET` (it is never shown), then applies the migrations. Every later
`pnpm run deploy` builds, applies new migrations, and only then deploys.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard
(Workers & Pages › your Worker › Settings › Variables and Secrets) or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Text variables and secrets both stay through a deploy, because `wrangler.jsonc` sets `keep_vars`. A
copy older than v0.28.1 lost its text variables on every deploy, so look through them after
updating. A site key missing there means the request forms were not open.

| Name                        | What it does                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`        | Signs sessions. Required.                                                     |
| `BETTER_AUTH_URL`           | The address people use, such as `https://track.example.com`. Turns on MCP.    |
| `GITHUB_CLIENT_ID`          | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                  |
| `GITHUB_CLIENT_SECRET`      | The client secret of the same GitHub OAuth app.                               |
| `OIDC_ISSUER`               | Turns on an OpenID Connect provider, with the two below. See below.           |
| `OIDC_CLIENT_ID`            | This deployment's client ID at the provider.                                  |
| `OIDC_CLIENT_SECRET`        | Its client secret there.                                                      |
| `OIDC_PROVIDER_NAME`        | What the sign-in button calls it. Unset: "single sign-on".                    |
| `GITHUB_APP_SLUG`           | Turns on the GitHub App, with the three below. See below.                     |
| `GITHUB_APP_CLIENT_ID`      | The GitHub App's client ID.                                                   |
| `GITHUB_APP_CLIENT_SECRET`  | The GitHub App's client secret.                                               |
| `GITHUB_APP_WEBHOOK_SECRET` | The secret that signs the GitHub App's deliveries.                            |
| `EMAIL_FROM`                | Turns on email, such as `Gateweave Track <track@example.com>`.                |
| `ATTACHMENT_QUOTA_MB`       | Limits each workspace's attached files, such as `1024`. Unset or blank: none. |
| `LEGAL_NOTICE_URL`          | The address of your legal notice. See below.                                  |
| `PRIVACY_POLICY_URL`        | The address of your privacy policy.                                           |
| `TERMS_URL`                 | The address of your terms.                                                    |

### Your legal pages

Track comes with no legal notice, privacy policy or terms, and never links to Gateweave's: whoever
runs a copy decides what applies to it. Set any of the three addresses above, and it is linked from
the sign-in pages, the workspace menu and the public request form. With `TERMS_URL` set, the sign-in
page also says that continuing means agreeing to them.

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

### GitHub pull requests and commits

Connecting repositories needs no app or secret on the server. An admin adds a connection under
Settings, GitHub, and adds a webhook on GitHub with the payload URL and secret shown there:
content type `application/json`, and the Pull requests and Pushes events. GitHub must be able to
reach your address, so a local `http://localhost` cannot receive deliveries.

Instead, admins can install a GitHub App on the repositories they choose, once you register one
for your deployment. Create it under GitHub's Settings, Developer settings, GitHub Apps, with your
address in place of `https://track.example.com`:

- **Callback URL:** `https://track.example.com/api/github/app/callback`. Leave "Expire user
  authorization tokens" on, and "Request user authorization (OAuth) during installation" off: it
  would replace the setup URL. Track sends the admin to authorize the app itself, and connects an
  installation only once GitHub lists it among the installations they can reach, on an account
  they control: an organization they are an owner of, or their own user account.
- **Setup URL:** `https://track.example.com/api/github/app/setup`, with "Redirect on update" on,
  so that choosing other repositories comes back to Track too.
- **Webhook:** active, with the URL `https://track.example.com/api/github/app` and a secret you
  make, such as one from `openssl rand -hex 32`.
- **Permissions:** Pull requests and Contents, read-only, and Metadata, read-only, on
  repositories; and Members, read-only, on organizations, which lets Track ask GitHub whether the
  person connecting an organization's installation is its owner.
- **Events:** Pull request and Push.
- **Where it can be installed:** any account, unless only your own organization uses it.

GitHub will not install an app until it has a private key, so generate one on the app's page. Track
never signs as the app and does not read the key, so you can delete the downloaded file.

Then set `GITHUB_APP_SLUG` to the app's name in its URL (`github.com/apps/<slug>`),
`GITHUB_APP_CLIENT_ID` to its client ID, and the client secret and webhook secret as secrets:
`pnpm wrangler secret put GITHUB_APP_CLIENT_SECRET` and
`pnpm wrangler secret put GITHUB_APP_WEBHOOK_SECRET`. Settings, GitHub then offers "Install GitHub
App" next to adding a webhook. Only an owner or admin of the workspace who is also an owner of
the GitHub organization the app is installed on (or the GitHub user, for an installation on a
personal account) can connect it; someone who can only read some of its repositories cannot. An
installation belongs to one workspace at a time; disconnecting it in Settings, GitHub frees it
for another workspace at once. An app registered before Members was in its permissions has to
ask its installations to accept the new permission, under the app's Permissions & events.

### Request forms

Each team can have a public request form, whose link an admin shares so that people without an
account file requests into the team's intake. Forms take requests only once
[Turnstile](https://developers.cloudflare.com/turnstile/) keeps bots out:

1. In the Cloudflare dashboard, add a Turnstile widget for your hostname (Managed mode).
2. Set `TURNSTILE_SITE_KEY` to its site key and `TURNSTILE_SECRET_KEY` to its secret key, the
   second as a secret: `pnpm wrangler secret put TURNSTILE_SECRET_KEY`.

Without both, admins can still turn a form on, but its link says the form is not open. Each
client network can file 10 requests an hour and 30 a day across all forms.

### Intake email

Each team can also have an intake email address, which files the email it gets as requests in
the team's intake. Teams usually forward their support address to it. To turn addresses on:

1. Pick a domain or subdomain that receives no other mail, such as `requests.example.com`, in a
   zone on Cloudflare, and enable [Email Routing](https://developers.cloudflare.com/email-routing/)
   on it.
2. Add a catch-all rule that sends every address to the Worker (`gateweave-track`, or your
   Worker's name).
3. Set `INTAKE_EMAIL_DOMAIN` to that domain.

Admins then turn on each team's address next to its form. Each sender can file 10 requests an
hour and 30 a day, and each address takes at most 60 an hour and 300 a day. Attachments go into
the bucket for attached files, where there is one.

### Sign in with GitHub

Create a [GitHub OAuth app](https://github.com/settings/developers) whose redirect URI, which
GitHub has also called the callback URL, is `https://track.example.com/api/auth/callback/github`
(your address), then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Sign in through an OpenID Connect provider

Any OpenID Connect provider can sign people in: Gateweave ID, Pocket ID, authentik, Keycloak, Okta
and others. It adds a button to the sign-in page, and passwords keep working.

1. Register Track with the provider as a confidential client that uses the authorization code
   flow and `client_secret_basic`, with the scopes `openid`, `profile` and `email`:
   - Redirect URI: `https://track.example.com/api/auth/callback/oidc` (your address)
   - Back-channel logout URI, if the provider has them:
     `https://track.example.com/api/auth/backchannel-logout/oidc`
2. Set `OIDC_ISSUER` to the provider's issuer, the address its
   `/.well-known/openid-configuration` is under, then `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
   `OIDC_PROVIDER_NAME` names the button, as in "Continue with Acme".

Someone new gets an account. Someone whose address already has one links to it only when the
provider says the address is verified and they have verified it in Track too, so anyone who could
sign up at the provider with that address cannot take over the account. Without
[email](#email) nobody can verify an address in Track, so existing accounts stay with their
passwords.

If the provider is down, its button says so, and everything else keeps working. People already
signed in stay signed in, because Track asks the provider nothing except when someone uses that
button or the provider signs someone out. With the back-channel logout URI registered, signing out
at the provider ends the Track sessions it started. Signing out of Track leaves the provider's
session alone.

If Track and the provider are both Workers, give each a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication).
A Worker cannot reach another on its own zone through a route, and two on `workers.dev` cannot reach
each other at all: Cloudflare answers with error 1042, and the button says it could not reach the
provider. If they have to stay on `workers.dev`, add `global_fetch_strictly_public` to
`compatibility_flags` in each one's `wrangler.jsonc`.

### Email

Without email, admins share invitation links themselves and nobody can reset a forgotten
password. To turn it on:

1. Onboard a domain to [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/):
   `pnpm wrangler email sending enable example.com`. Sending to any address needs the Workers Paid
   plan.
2. Set `EMAIL_FROM` to a sender on that domain, such as `Gateweave Track <track@example.com>`.

Track then sends password resets, address verification, invitations and, to people who want
them, emails of inbox news they leave unread. With email on, joining a workspace requires a
verified address. Serve Track over HTTPS (a `workers.dev` or custom domain is) so that those
emails carry a one-click unsubscribe link: Email Service refuses one over HTTP.

## The public demo

Gateweave's own demo (a private sandbox per visitor, deleted after a day) is a separate
deployment, the `demo` environment in `wrangler.jsonc`. You do not need it: it is off unless the
`TRACK_DEMO` variable is `"1"`, which only that environment sets. See
[the architecture notes](architecture.md#the-public-demo).
## Updating

**Command line:** `git pull`, `pnpm install`, `pnpm run deploy`.

From a version without attachments, the next deploy creates the R2 bucket, so R2 must be on in
the account first (see the top of this page).

**Button:** your copy does not follow this repository on its own, and shares no history with it,
so `git pull` refuses. This takes the latest release into your copy instead, as one commit on top
of it. A copy can skip releases, however old it is:

```sh
git remote add upstream https://github.com/gateweavehq/track.git   # once
git fetch upstream
git show upstream/main:scripts/update-copy.mjs | node --input-type=module
git push
```

The script pushes nothing, and `git reset --hard HEAD~1` undoes it until you do. The push is what
deploys: Workers Builds builds it and applies the D1 migrations, each workspace's Durable Object
applies its own the next time it wakes, and open tabs reload if the protocol changed.

If GitHub refuses the push with `push declined due to email privacy restrictions`, the commit
carries the address your GitHub settings keep private. Use the `noreply` address those settings
show you, and make the commit again:

```sh
git config user.email "<your noreply address>"
git commit --amend --reset-author --no-edit
git push
```

What your copy changed stays: the Worker's, database's and bucket's names in `wrangler.jsonc`, the
name in `package.json`, and having no workflows. If something else you changed conflicts with the
release, the script names the files for you to fix before committing. To take a release other than
the latest, end the third line with `node --input-type=module - --to v1.2.3`.

Track is in early development. Read [CHANGELOG.md](../CHANGELOG.md) before updating, as some
releases change how things work.
