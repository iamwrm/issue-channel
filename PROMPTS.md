# issue-channel prompts

Usage: type your topic or task, then paste one of these prompts after it. Replace `<owner/repo>` with your repo, and set `ISSUECHAN_DIR` to your issue-channel checkout (see the README quick start). Run them in a Claude Code session started with `claude --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`.

## Start: create an issue and listen to it

```text
Create a new issue in <owner/repo> for the topic above, subscribe to it with issuechan, check that the subscription is listed and the server health check passes (tell me to reconnect issuechan via /mcp if its tools are missing), then post a short welcome reply and give me the link.
```

## Start: listen to an existing issue

```text
Subscribe with issuechan to the GitHub issue mentioned above, confirm it is listed, and post a short reply on it saying you are listening.
```

## Live status comment

```text
While working on the task above, post one status comment on the subscribed issue with a headline and a Step/Status/Notes table, keep editing that same comment in place with gh as each step progresses (starting with the same `🤖 <tag> ·` prefix as issue_reply and always keeping the bot marker as the last line), and post a final summary with issue_reply when everything is done.
```

## Propose issue to repo

Version: `v20261011.1`

```text
Propose moving the durable content of the subscribed issue into <owner/repo>, which is the source of truth (the issue is only a working surface we can wipe at any time): back up the issue first, then reply with a table mapping each part of the description and comments to a repo file (decisions to docs/DECISIONS.md as numbered dated entries, measured results next to the code they test, open items to BACKLOG.md with stable ids, how-tos to the READMEs, design rationale to DESIGN.md; history is dropped in favour of git log and the backup), what the issue keeps afterwards (links, the request being worked on, the backlog ids it covers), and any questions. Don't change the repo or the issue until I say go; then do it as one PR and shrink the issue only after the PR is merged.
```

## Consolidate the conversation

Version: `v20261011.1`

```text
Consolidate the whole subscribed issue using the issue-channel skill (reference/consolidate.md): back up the issue and all its comments, move anything durable (decisions, results, open items, how-tos) into the repo as one PR, and once it is merged rewrite the description as links plus the active work, post at most one short comment saying what moved where (PR link, backup path), delete all the older comments including this request, and mark it done with issue_done.
```

## Launch a new agent on a new issue

```text
Create a new issue in <owner/repo> for the topic above, start a fresh agent listening to it with `$ISSUECHAN_DIR/spawn/spawn-agent.sh` under a short session name you pick, and give me the issue link and the tab id.
```

## Compact yourself (replace yourself with an edited-context successor)

```text
Compact your context with the live-context skill: `ctx open`, tidy the file with one script (keep what the work needs, trim or drop the rest block by block, put this turn's results in a `[[NOTE]]` at the end), then `ctx apply --then "<what to do next>"` and end the turn. After the switch, post the `ctx report` table on the subscribed issue.
```

To give another agent a cleaner context, use `session-fork mirror --full <its id>` and `spawn/restart-agent.sh --fork` instead ([README](README.md#agent-lifecycle)); never mirror your own session ([D8](docs/DECISIONS.md#d8-self-compaction-goes-through-the-neutral-live-context-skill)).

## No-compact (reset an idle agent without a summary)

Post on the agent's issue, after a long idle (prompt cache expired) and before asking it anything:

```text
/bot !no-compact
<optional: a question, delivered to the reset session as a normal /bot>
```

`/bot !no-compact <name>` picks one session when several listen. The channel matches it by code, so the stale context is never sent; a code reply reports `cc:<old> → cc:<new>`. See [spawn/README.md](spawn/README.md#no-compact).

## Dispatch to another issue

```text
Dispatch the task above to a worker agent: create a new issue in <owner/repo> for it, fork your session with `$ISSUECHAN_DIR/session-fork/session-fork.mjs` keeping only the turns the worker needs plus a note describing the task, start the fork on the new issue with `$ISSUECHAN_DIR/spawn/spawn-agent.sh --resume <fork id> --task <the task>` under its own session name, and give me the issue link.
```

## Wrap up

```text
Post a final summary on the subscribed issue, close it, and unsubscribe from it.
```
