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

| Product    | What it does                                          | Status             |
| ---------- | ----------------------------------------------------- | ------------------ |
| **Track**  | Issues, projects and planning for product teams       | In development     |
| **Agents** | AI agents that work inside every product as members   | Next, inside Track |
| **ID**     | Single sign-on, passkeys and access to internal apps  | Proposed           |
| **Mail**   | Shared inboxes, and email in and out of every product | Proposed           |
| **CRM**    | Contacts, companies and deals                         | Proposed           |
| **ERP**    | Invoicing, inventory and orders, one module at a time | Later              |

## Shared platform

Built once and used by every product.

### Identity and workspaces

One Gateweave account per person and one workspace per team, shared by every product. A workspace
is the Better Auth organization Track already uses, so members, roles and invitations carry
over unchanged.

- In Gateweave Cloud, an identity Worker owns the users and workspaces in D1. Product Workers
  verify sessions through a service binding, so a sign-in on one product covers all of them.
- Self-hosted products keep working on their own with built-in auth, and can point to a shared
  identity Worker when a team runs more than one.

The identity Worker is also a product of its own, **Gateweave ID**, in the space of Pocket ID and
authentik but with no server to run:

- **An OpenID Connect provider for any app.** Grafana, Gitea, Outline or anything else that
  supports OIDC signs people in with their Gateweave account. It is the same Better Auth OAuth
  provider that already signs AI agents in to Track's MCP server.
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
  person accepts them.
- Models are reached through Cloudflare AI Gateway, so any provider works, with caching, rate
  limits and logs. Workers AI covers models that should run on Cloudflare.
- Each product also exposes its queries and mutations as an MCP server, so outside agents can use
  Gateweave with the user's permission.

Starting inside Track, with an agent that triages new issues, grounds the framework in a real
job before it becomes a product of its own.

### Email

Cloudflare Email Routing handles inbound mail and Email Sending handles outbound. Track needs
both first: invitations, notifications and email-to-issue. Mail grows from that into shared
inboxes. CRM then uses it to keep conversations with customers alongside deals.

### Interface

A shared design system (`@gateweave/ui`), extracted from Track's shadcn-based components at the
same time as the sync engine. Every product gets the same keyboard-first command palette.

## Order of work

1. **Track:** MVP, then launch. Proves the stack and builds an audience.
2. **Agents in Track:** issue triage. A differentiator for the launch and the first real user
   of the agent design.
3. **ID:** the identity Worker, extracted from Track's auth (which already includes an OAuth
   provider for MCP), first as single sign-on across Gateweave products, then for any app.
4. **Mail, starting small:** what Track needs anyway (notifications, email-to-issue), then
   shared inboxes.
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
