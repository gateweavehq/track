# The Gateweave ecosystem

> **Status: draft proposal.** This describes where the product family could go and the
> architecture that would let it get there. Nothing here is built yet except Track itself.

[Gateweave](https://gateweave.com) is the umbrella for a family of open-source business tools that
run natively on Cloudflare. Gateweave Track, the issue tracker in this repository, is the first.
Products are named Gateweave plus a plain word for what they do: Gateweave Track, Gateweave Mail,
Gateweave CRM.

## Why a family

Teams run on a handful of tools that each hold part of the picture: issues, customers, email,
orders. Each one is usually a separate vendor with its own login, its own permissions and its own
copy of the team. Gateweave products share one account, one workspace and one way of syncing
data, so they work on their own and get better together. They are also built for AI agents to
work in alongside people, not bolted onto afterwards.

Every product follows the same principles as Track:

- **Cloudflare-native.** Workers, Durable Objects, D1 and R2. Nothing to operate, and one
  deploy per product.
- **Local-first.** Data is replicated to the client, so the UI is instant and works offline.
- **Open source.** AGPL-3.0, self-hostable, with a hosted cloud for teams that prefer it.

## Products

| Product    | What it does                                                      | Status                                                                     |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Track**  | Issues, projects and planning for product teams                   | Early access                                                               |
| **Agents** | Coding agents' setups, and agents and teams that run on their own | Early access ([gateweavehq/agents](https://github.com/gateweavehq/agents)) |
| **ID**     | Single sign-on, passkeys and access to internal apps              | Early access ([gateweavehq/id](https://github.com/gateweavehq/id))         |
| **Mail**   | Mailboxes for people and agents, aliases and transactional email  | Next, being designed; email-to-issue and inbox email ship in Track         |
| **CRM**    | Contacts, companies and deals                                     | Proposed                                                                   |
| **ERP**    | Invoicing, inventory and orders, one module at a time             | Later                                                                      |

## Shared platform

Built once and used by every product.

### Identity and workspaces

One Gateweave account per person, from **Gateweave ID**: an OpenID Connect provider in the space of
Pocket ID and authentik, with no server to run.

Products are ordinary OIDC clients of ID. Each keeps its own users, sessions, workspaces and
built-in sign-in, in Gateweave Cloud and self-hosted alike:

- **One path.** Cloud and self-hosting differ only by configuration, so there is one sign-in flow
  to test and secure.
- **Failure stays contained.** People already signed in keep working while ID is down.
- **Nothing moves.** No product's data migrates, and the gateways' membership checks stay as they
  are.
- **We use what customers use.** Track and Agents sign in the way Grafana or Gitea do.

This replaces an earlier plan in which product Workers verified one shared session through a service
binding. That needed ID up for every request, and a second path for self-hosters.

It gives a person one account, not a team one workspace: Track and Agents each keep their own.
Subscriptions per workspace in Gateweave Cloud need that solved, and it is still an open design.

ID's own design is in its [architecture notes](https://github.com/gateweavehq/id/blob/main/docs/architecture.md).
It offers:

- **An OpenID Connect provider for any app.** Grafana, Gitea, Outline or anything else that
  supports OIDC signs people in with their Gateweave account. A workspace owns its apps, and only
  its members can use them.
- **Passkeys and MFA**, groups, and per-app rules for who may sign in.
- **Access to internal apps.** Pangolin's job, protecting self-hosted apps without opening ports,
  is what Cloudflare Tunnel and Cloudflare Access already do. Gateweave ID is the identity
  provider behind Access and sets both up from one screen, so there is no tunnel server to build
  or run.
- SAML, SCIM provisioning and audit export are enterprise features in `ee/`.

### Data stays per product

Each product keeps each workspace's data in its own Durable Object namespace, keyed by the
workspace id, the way Track's `WorkspaceDO` does. Products deploy, scale and migrate
independently, and a bug in one cannot touch another's data. Membership hooks fan out to every
product's Durable Object.

Products link to each other's records by reference (`gateweave:track:issue:<id>`) and resolve
references with RPC over service bindings, checking membership on the way. There is no shared
database across products.

### One sync engine

Track's sync engine is general except for its domain: its entities, mutation schemas, server
handlers and client predictions. When the second product starts, extract the engine into a
`@gateweave/sync` package that takes a domain definition and runs it. The `@gateweave` npm
organization is already reserved for shared packages like this one.

The seams are already in place. The protocol separates messages from mutations. The server
dispatches through `applyMutation`. The client replays `optimistic.ts` on a `Replica` whose tables
follow the entity list. The client reaches the network and storage only through its `Transport`
and `Persistence` interfaces.

Extracting before a second real consumer exists would mean designing the abstraction by guessing.
So it waits for the second product.

### Agents are members

An agent is a workspace member with an `agent` role, created and scoped by an admin. In Track
this is built: an admin creates one under Settings, Agents, and it connects to the MCP server
with a key (see [architecture.md](architecture.md#agent-members)). It works the way a person's
browser does:

- It **acts through the same mutations.** Validation, permissions, idempotency, field-level
  merging and the oplog's actor field (an audit trail) apply unchanged, and people see an agent's
  edits live.
- It **observes through the same sync stream.** The client depends only on `Transport` and
  `Persistence`, so an agent can run the sync client inside a Durable Object (Cloudflare Agents
  SDK) with Durable Object storage instead of IndexedDB. It reacts to changes as they happen.
  An agent that sleeps between tasks instead hears about them from a signed webhook (see
  [architecture.md](architecture.md#webhooks)), which is built in Track.
- **People stay in control.** High-impact changes can be proposed instead of applied, and a
  person accepts them. Track does this for agent members (see
  [architecture.md](architecture.md#proposals)).
- Models are reached through Cloudflare AI Gateway, so any provider works, with caching, rate
  limits and logs. Workers AI covers models that should run on Cloudflare.
- Each product also exposes its queries and mutations as an MCP server, so outside agents can use
  Gateweave with the user's permission.

Starting inside Track, with an agent that triages new issues, grounds the framework in a real
job before it becomes a product of its own.

### Email

Cloudflare Email Routing handles inbound mail and Email Sending handles outbound. Track already
uses both: invitations, notifications and email-to-issue. Mail is its own product on the same two
services: a mailbox per person or agent, each in its own Durable Object, addresses an agent can
make for itself, aliases, shared inboxes, transactional sending and templates. CRM then uses it
to keep conversations with customers alongside deals.

### Interface

A shared design system (`@gateweave/ui`), extracted from Track's shadcn-based components at the
same time as the sync engine. Every product gets the same keyboard-first command palette.

## Order of work

1. **Track:** MVP, then launch. Proves the stack and builds an audience.
2. **Agents in Track:** issue triage. A differentiator for the launch and the first real user
   of the agent design.
3. **ID:** an OpenID Connect provider, first as single sign-on across Gateweave products, with
   Track and Agents as its first clients, then for any app.
4. **Mail, starting with agents:** mailboxes for agents, with what each may touch and what a
   person can see of it. Then sending and templates, mailboxes for people, and aliases.
5. **CRM:** the second full product. Starting it triggers extracting `@gateweave/sync` and
   `@gateweave/ui`.
6. **ERP:** last, one module at a time (invoicing first). It is the largest and most regulated
   area: accounting rules and e-invoicing differ by country. Each module should earn its place
   against integrating with an existing system.

## Open source and business

- Every product is AGPL-3.0 and self-hostable.
- Enterprise features (SAML SSO, audit export, advanced permissions) live in an `ee/` directory
  under a commercial license: the open-core model.
- **Gateweave Cloud** hosts every product. A workspace subscribes to the products it uses, and
  bundles cost less than the sum of their parts.
- One contributor license agreement covers every Gateweave project, so contributions can ship in
  both the open-source and commercial editions.

## Decisions for the maintainer

- **Repository layout.** Products as separate repositories with shared packages published from a
  platform repository, or one monorepo. Separate repositories keep each product approachable for
  contributors; a monorepo keeps cross-product changes atomic. Recommendation: separate
  repositories, decided when the second product starts.
