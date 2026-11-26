# Write a project's weekly update from the board

An AI agent reads a project's last week from the board, compares it with the previous update, and posts
a new update with a health.

**How far this has been checked.** On 2026-11-26 this prompt was run end to end twice through Track's
MCP tools against Gateweave Cloud, in a test workspace, signed in with OAuth as its owner, on a test
project with an earlier update. The example below is from the first run. In the second, the agent showed
the update and its health and ended its turn with nothing posted; the yes came in a separate message,
and it then posted the update. The test issues were canceled afterwards. [What has not been
tried](#what-has-not-been-tried) has the rest.

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

1. `get_insights` with `project` and `weeks` of `4`, `12` or `26` gives the created and closed counts of
   each week, the totals of all the weeks, the open count now, and the median cycle time. Give it a
   project or a team, not both. The recipe's period is the last week it lists: from that Monday, in
   UTC, until today.
2. `list_project_updates` gives the previous update, the latest first.
3. `search_issues` with `project` gives the project's issues, each with its status and `updatedAt`. It
   returns 50 by default; `limit` goes up to 200, and there is no way to get the rest.
4. `post_project_update` posts the new one. It takes `project`, `health` (`on_track`, `at_risk` or
   `off_track`) and `body` in Markdown.

## The prompt

```text
Write the update for this week so far, for the project "Website launch" in the Track workspace `acme`.

1. Call get_insights for the project with weeks 4. Take the last entry of `weeks`: its `start` is a
   Monday (UTC) and is the first day of the reporting period, which runs until today. Write both
   dates down. For the period, use that entry's `created` and `closed`, not the top-level `created`
   and `closed`, which add up all four weeks. `open` is how many issues are open now.
2. Call list_project_updates for the project with limit 1, and read the previous update.
3. Call search_issues for the project with limit 200. Of the issues whose updatedAt is on or after the
   start date, note which are done and which are in progress. Of all the issues returned, note which
   are open with nobody assigned. If the call returns 200 issues, say in the update that the list may be
   incomplete: the tool gives no total and cannot return the rest.
4. Write the update in Markdown with three short parts: what happened, what comes next, and what is in
   the way. Begin with the reporting period's dates. Name issues by key. Say what changed since the
   previous update. Give the period's created and closed counts as "this week" and the open count as
   "now". Say a done issue was updated in the period, not that it was finished then. Use only what the
   tools returned; if a number is missing, say so.
5. Choose a health: on_track, at_risk or off_track. Say in one line why.
6. Show me the update and the health. Post it with post_project_update only after I say yes.
```

## What you should see

The agent shows an update and a health first. After your yes, `post_project_update` returns the new
update's `id`, `health`, `author` (your email), `body`, `createdAt` and `edited: false`. In the check,
run on a Thursday, the update read like this (the keys are examples):

```text
**Period.** Monday 2026-11-23 to Thursday 2026-11-26 (UTC), this week so far.

**What happened.** This week: 5 issues created and 3 closed (closed counts done and canceled). Done,
and updated this period: ENG-41, the sign-up form fix. Since the previous update, the launch email
(ENG-42) has been started and ENG-43 was added.

**What comes next.** The launch email (ENG-42) is in progress now that the form fix has landed.

**In the way.** Nothing. Open now: 2 issues, both with nobody assigned (ENG-42 and ENG-43).

Median cycle time is 0 days over 1 issue: ENG-41 was started and finished within the same minute.
```

The counts took the period from the last entry of `weeks` (`created` 5, `closed` 3); the top-level
`created` and `closed` were the same here only because the earlier three weeks were empty. On a Monday
the period is a day long, and the update says so.

What the tools returned that the update has to be careful with:

- `get_insights` has one entry per week in `weeks`, oldest first, each starting on a Monday (in UTC, for
  a project). Its last entry is the week now, which is not over. The top-level `created` and `closed`
  add up every week in the range, and `open` is the count now, so only the last entry's counts belong
  to the period.
- `closed` counts a move into a completed or a canceled status, so canceled issues are in it.
- `medianDays` is `null` when no issue in the range went from started to done. An issue moved straight
  to Done is closed but has no cycle time.
- For a project, `get_insights` gives `openByTeam`, `openByAssignee` and `openByLabel`. `openByStatus` is
  only for a team.
- The project's health is that of the latest update, so a new update replaces the last one's.

## What has not been tried

- A project with no earlier update, where `list_project_updates` has nothing to return.
- More than 200 issues, where the prompt tells the agent the list may be incomplete, and `weeks` of
  `12` or `26`.
- A person typing the answer at step 6. In the check, the yes came from the session that ran it, as a
  separate message after the agent had ended its turn.
- An agent member posting the update, and the health `at_risk` or `off_track`.
- Editing or deleting an update afterwards.
