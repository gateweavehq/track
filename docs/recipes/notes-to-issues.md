# Turn meeting notes into issues

An AI agent reads your notes, shows you the issues it would create, and creates them, with what blocks
what, once you say yes.

**How far this has been checked.** On 2026-11-26 this prompt was run end to end through Track's MCP
tools against Gateweave Cloud, in a test workspace, signed in with OAuth as its owner. The run stopped
after the list, checked that nothing had been created, and went on when the test session gave the yes.
The issues it made were canceled afterwards. [What has not been tried](#what-has-not-been-tried) has
the rest.

## Before you start

- Connect your agent to Track as [How to connect](../mcp.md#how-to-connect) says.
- Any member of the workspace can do this, and so can an agent member: `get_workspace`, `create_issue`
  and `link_issues` need nothing more (see [the tools table](../mcp.md#tools)).

## Steps

1. Open a session in your agent with Track connected.
2. Paste the prompt below, with your own notes and your workspace's slug in place of `acme`.
3. Read the list the agent shows. Answer `yes`, or say what to change.
4. Read the keys it reports at the end.

The agent works in this order:

1. `get_workspace` gives the teams (and their keys, such as `ENG`), the labels and the projects.
2. It shows what it would create and stops. Nothing is created before your yes.
3. `create_issue` makes one issue per item. It needs `workspace`, `team` and `title`, and takes
   `description`, `labels` (names), `project` and `priority` when the notes call for them.
4. `link_issues` relates them. It needs both keys, so the blocking issues are created first: `key`
   blocks `to`.

## The prompt

```text
Turn the meeting notes below into issues in the Track workspace `acme`.

1. Call get_workspace for `acme`. Read its teams, labels and projects.
2. List every issue you would create, one line each: the team key, the title, a one-line description,
   a label or project only if one of the existing ones clearly fits, and the titles of any issues in
   the list that it blocks. Do not invent labels, projects or teams. If an item could go to more than
   one team, say which you chose.
3. Stop and wait for me to answer yes, or to tell you what to change. Create nothing before that.
4. After a yes, create each issue with create_issue. Then add each "blocks" relation with link_issues.
5. Finish with a table of the keys you created, their titles, and what blocks what.

Notes:
- Sam will fix the sign-up form: it accepts addresses with no @. This has to be done before the
  launch email goes out.
- Someone sends the launch email to the waiting list.
- Search takes several seconds on a big workspace. Nobody knows why yet.
```

## What you should see

First, a list of three issues and one relation, and nothing created yet. After your yes, the agent makes
the issues and ends with something like this:

| Key      | Title                              | Blocks   |
| -------- | ---------------------------------- | -------- |
| `ENG-41` | Fix the sign-up form's email check | `ENG-42` |
| `ENG-42` | Send the launch email              |          |
| `ENG-43` | Find out why search is slow        |          |

In Track, the three issues are in the team's first status, usually Backlog, with you as their creator.
Open `ENG-42`: it shows as blocked by `ENG-41`.

What each call returned in the check:

- `create_issue` returned the new issue's `key`, `title`, `status`, `priority`, `labels`, `project`, `url`
  and `creator`. It leaves the description out unless you pass `include: ["description"]`. Nobody was
  assigned, as the prompt names no one.
- `link_issues` returned the first issue's `relations`: a `blocks` entry that names the other issue.
  Two issues have one relation at most: linking them with a different relation replaces the previous
  one, and repeating the same relation changes nothing. In the check, repeating `blocks` returned the
  same relation, and `related` in its place returned `related` only.

Sam is in the notes but not in the issues. To assign people, add "assign an issue to the member the
notes name, if one matches" to the prompt: `get_workspace` lists the members, and `create_issue` takes
`assignee`.

## What has not been tried

- A person answering at step 3. The session that ran the check stopped before any write and then gave
  the yes itself, so a person's reply in a live conversation with the agent was not tried.
- Notes long enough to need more than one team, or a workspace with several projects.
- Labels, projects and assignees on created issues, and a template (`create_issue`'s `template`).
- An agent member as the one who creates the issues. If an admin set it to propose some kinds of change,
  `create_issue` still makes the issue at once. Only the configured field changes on it (a status other
  than the team's first, a priority, an assignee, a project or a label) are held: they come back under
  `proposed`, and the issue keeps its defaults until a person accepts them in Track.
