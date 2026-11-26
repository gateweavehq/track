# Write a project's weekly update from the board

An AI agent reads a project's last week from the board, compares it with the previous update, and posts
a new update with a health.

**How far this has been checked.** On 2026-11-26 this prompt's steps were run through Track's MCP tools
against Gateweave Cloud, in a test workspace, signed in with OAuth as its owner, on a project with two
issues and one earlier update. [What has not been tried](#what-has-not-been-tried) has the rest.

## Before you start

- Connect your agent to Track as [How to connect](../mcp.md#how-to-connect) says.
- The project has to exist. Creating one takes a person who is a member of the workspace, not an agent
  member (`create_project`). Once it exists, any member, an agent member included, can read it and post
  updates (see [the tools table](../mcp.md#tools)).

## Steps

1. Open a session in your agent with Track connected.
2. Paste the prompt below, with your workspace's slug and your project's name in place of `acme` and
   `Website launch`.
3. Read the update the agent shows you. Say what to change, or say `yes`.
4. Open the project in Track: the update is on its page, and its health is now the project's health.

The agent works in this order:

1. `list_project_updates` gives the previous update, the latest first.
2. `search_issues` with `project` gives the project's issues, each with its status and `updatedAt`. It
   returns 50 by default; `limit` goes up to 200.
3. `get_insights` with `project` and `weeks` of `4`, `12` or `26` gives the created and closed counts of
   each week, the open count now, and the median cycle time. Give it a project or a team, not both.
4. `post_project_update` posts the new one. It takes `project`, `health` (`on_track`, `at_risk` or
   `off_track`) and `body` in Markdown.

## The prompt

```text
Write this week's update for the project "Website launch" in the Track workspace `acme`.

1. Call list_project_updates for the project with limit 1, and read the previous update.
2. Call search_issues for the project with limit 200. Keep the issues whose updatedAt is in the last
   7 days. Note what is done, what is in progress, and what is open with nobody assigned.
3. Call get_insights for the project with weeks 4. The last entry of `weeks` is the week that is not
   over yet. Use the created and closed counts, and the open count.
4. Write the update in Markdown with three short parts: what happened, what comes next, and what is in
   the way. Name issues by key. Say what changed since the previous update. Use only what the tools
   returned; if a number is missing, say so.
5. Choose a health: on_track, at_risk or off_track. Say in one line why.
6. Show me the update and the health. Post it with post_project_update only after I say yes.
```

## What you should see

The agent shows an update and a health first. After your yes, `post_project_update` returns the new
update's `id`, `health`, `author` (your email), `body`, `createdAt` and `edited: false`. In the check the
update read:

```text
**This week.** 2 issues created, 1 closed. The sign-up form fix is done (ENG-41).

**Next.** The launch email (ENG-42) is in progress now that the form fix has landed.

**In the way.** Nothing. 1 issue is open, with nobody assigned to it.

Median cycle time is not known yet: the one closed issue was never started.
```

What the tools returned that the update has to be careful with:

- `get_insights` has one entry per week in `weeks`, oldest first, each starting on a Monday (in UTC, for
  a project). Its last entry is the week now, which is not over.
- `medianDays` is `null` when no issue in the range went from started to done. An issue moved straight
  to Done is closed but has no cycle time.
- For a project, `get_insights` gives `openByTeam`, `openByAssignee` and `openByLabel`. `openByStatus` is
  only for a team.
- The project's health is that of the latest update, so a new update replaces the last one's.

## What has not been tried

- A project with no earlier update, where `list_project_updates` has nothing to return.
- More than 50 issues, and `weeks` of `12` or `26`.
- A person answering at step 6. The check ran the steps from one session.
- An agent member posting the update, and the health `at_risk` or `off_track`.
- Editing or deleting an update afterwards.
