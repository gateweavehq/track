# Triage a team's intake

An AI agent reads each request waiting in a team's intake and suggests accepting or declining it, and
which ones repeat another. You decide, and it makes the changes.

**How far this has been checked.** On 2026-11-26 this prompt was run end to end through Track's MCP
tools against Gateweave Cloud, in a test workspace, signed in with OAuth as its owner, on the three
test requests below. The run showed the table, checked that every request was still in intake, and
went on when the test session gave the yes. The requests were canceled or declined afterwards.
[What has not been tried](#what-has-not-been-tried) has the rest.

## Before you start

- Connect your agent to Track as [How to connect](../mcp.md#how-to-connect) says.
- The agent has to act as a person, a member of the workspace such as you, signed in with OAuth. Only
  people decide on requests. An agent member can call `triage_request`, but its decision is not made: it
  comes back under `proposed`, for a person to accept or dismiss in Track (see [the tools
table](../mcp.md#tools)).
- Declining a request that someone filed through a team's request form or intake email address can email
  them, with your reply. That is why the prompt asks you first.

## Test requests

Skip this if requests are already waiting. To try the recipe on test data:

1. Pick a team in your workspace to file them in. The rest of this page calls its key `ENG`.
2. For each row of the table, file a request on the team's intake page in Track, or ask your agent to
   call `create_issue` with the team's key, `intake: true`, and the row's title and description.

   | Title                               | Description                                                     |
   | ----------------------------------- | --------------------------------------------------------------- |
   | Export to CSV drops the last column | When I export the board to CSV, the Estimate column is missing. |
   | CSV export has no Estimate column   | Exporting issues as CSV leaves out Estimate.                    |
   | Please add a dark pirate theme      | Parrots in the sidebar, please.                                 |

3. Open the team's intake page and check that the three requests are there.

## Steps

1. Have requests waiting in the team's intake, such as the test requests above.
2. Paste the prompt below, with your workspace's slug and your team's key in place of `acme` and `ENG`.
3. Read the decisions the agent suggests. Answer `yes`, or say what to change.
4. Open the team's intake page in Track: the requests you handled are gone from it.

The agent works in this order:

1. `search_issues` with `team` and `intake: true` finds the requests waiting. With no `text`, the most
   recently updated come first.
2. `get_issue` reads each one: its description, comments and relations.
3. `link_issues` with `duplicate_of` relates a duplicate to the request it repeats.
4. `triage_request` with `decision` of `accept` or `decline`. Accepting can name an open `status` of the
   team; without one the request keeps its status. Declining moves it to the team's first canceled
   status, and `reply` is posted as a comment by you.

## The prompt

```text
Triage the requests waiting in the intake of team ENG in the Track workspace `acme`.

1. Call search_issues with team ENG, intake true and limit 200. Call get_issue on each one and read
   it. If the search returns 200 requests, tell me that more may be waiting: search_issues cannot
   return the rest.
2. For each request, suggest accept or decline:
   - Accept if it is a real problem or something we could do. Name an open status to accept it into
     only if it should not stay in the one it has.
   - Decline if it is out of scope or cannot be done. Write a short, polite reply for the person.
   - If two requests repeat each other, accept one and decline the other, with a reply that names the
     one we kept.
3. Show me a table of key, title, your suggestion and the reply for each decline. Do nothing before I
   answer yes, or tell you what to change.
4. After a yes: relate each duplicate to the request it repeats with link_issues and relation
   duplicate_of. Then call triage_request for each request. For an accept, send decision accept and,
   only if you chose a status other than the one it has, that status; send no reply. For a decline,
   send decision decline and the reply I approved; send no status. Do not touch any issue that is not
   in the list.
5. Finish with the keys, what you decided for each, and any call that failed.
```

## What you should see

First, a table like this, with nothing changed:

| Key      | Title                               | Suggestion                    | Reply                                                           |
| -------- | ----------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `ENG-9`  | Export to CSV drops the last column | Accept, into Todo             |                                                                 |
| `ENG-10` | CSV export has no Estimate column   | Decline, duplicate of `ENG-9` | Thanks. This is the same problem as ENG-9. Follow it there.     |
| `ENG-11` | Please add a dark pirate theme      | Decline                       | Thanks for the idea. We do not plan to build a theme like this. |

After your yes, in the check:

- `triage_request` with `accept` and `status` of `todo` returned the issue with `status` of `todo` and
  `intake: false`. It left the intake list and joined the team's lists and boards.
- `link_issues` with `duplicate_of` returned the duplicate's `relations`, with a `duplicate_of` entry for
  the request it repeats. It worked while the duplicate was still a request, and the relation was still
  there after the decline.
- `triage_request` with `decline` returned the issue with `status` of `canceled` and `intake: false`. The
  reply was in its comments, written under your name.
- A second `search_issues` with `intake: true` returned nothing.

`create_issue`'s answer does not say that an issue is a request; `search_issues` and `get_issue` do, as
`intake`.

`triage_request` refuses an issue that is not in intake ("is not a request in intake"), a `reply` on an
accept ("A reply is only for declining") and a `status` on a decline ("leave out status"). The check
tried all three, on requests it then handled as above, and none changed anything. That is why the
prompt sends a `status` only with an accept and a `reply` only with a decline.

## What has not been tried

- A person answering at step 3. The session that ran the check gave the yes itself, so a person's reply
  in a live conversation with the agent was not tried.
- An agent member as the one calling `triage_request`, and accepting its proposals in Track.
- Requests that arrived through a team's request form or intake email address, and the email to the
  person who filed one.
- A team with no canceled status, which cannot decline.
- Accepting into a status other than `todo`, and more than 200 requests, where the prompt tells the
  agent that more may be waiting.
