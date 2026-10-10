---
name: issue-channel
description: Work reliably through issue-channel (issuechan) on GitHub and Linear issues. Use whenever a <channel source="issuechan"> message arrives, when replying on, listening to, consolidating, closing or cleaning up a GitHub or Linear issue for the user, when reading images attached to an issue, when the user mentions /bot, a home issue, or a Linear ref like ENG-123, or when asked to restart yourself, compact or CLM-compact your context/session (this is session-fork + spawn/restart-agent.sh, not the built-in /compact).
---

# issue-channel

issuechan pushes the user's `/bot` comments from GitHub issues and Linear issues into this session, and its tools post your answers back. Most mistakes are about *which* request you mark done, *where* the answer goes, and *what* you delete. The rules below prevent them.

## Refs

| Where | `repo` | `issue` | Example |
|---|---|---|---|
| GitHub | `owner/name` | issue number | `iamwrm/mainbot`, `39` |
| Linear | `linear:<TEAM>` | issue number | ENG-123 → `linear:ENG`, `123` |

Comment ids are numbers on GitHub and UUIDs on Linear. Always pass the **full** id (copy the `trigger_comment` attribute); never shorten a UUID.

## Every delivery

1. A `<channel source="issuechan">` message is the user talking: act on it right away, then resume the task you were on unless told otherwise.
2. Answer on **the issue it came from** with `issue_reply`: a one-line `summary`, and the full answer as `body` (the same text you show in the terminal). On Linear the reply lands in the `/bot` comment's thread on its own; `reply_to` (full UUID) picks another thread.
3. **Done marking:** `issue_reply` and `issue_done` mark **every** open request on that issue done unless you pass `comment_ids`. So:
   - finished the request → `comment_ids: [<its trigger_comment>]` whenever other requests on that issue are still open, or might be;
   - progress update, plan, question back, or still working → `done: false`;
   - finished without a reply → `issue_done` with `comment_ids`.
4. Check what the tool returns (URL, "removed eyes, added rocket", errors) before telling the user it worked.
5. One delivery can hold several items (edits with a diff, deletions with the old text, issue-body edits): read them all; the `/bot` is the last one.

## Listening

- `issue_subscribe` starts from **now**: comments posted before it are never delivered. Right after subscribing to an existing issue, read its recent comments (`gh issue view N --comments`, or `scripts/linear.mjs issue ENG-123`) and answer any `/bot` nobody answered yet.
- **Linear issue you listen to = In Progress.** When the user asks you to create a Linear issue to listen to, create it already in that state: `scripts/linear.mjs create ENG --title "…" --description "…" --state in-progress`, then `issue_subscribe`. When the user asks you to listen to an existing Linear issue, subscribe and then `scripts/linear.mjs set-state ENG-123 in-progress` (unless it is already started or closed: then leave it and say so). Mention the state in your reply.
- **Home issue:** each agent keeps one long-lived issue (label `bot`) as its inbox, never closed when a task is done; work topics get their own issues, where results and decisions go. One home per agent. Subscribe under a session name equal to the home's name so `/bot <name>` reaches you anywhere.
- `/bot <word>` with a single word on the first line targets the session `<word>`; an unknown word counts as untargeted. `/bot done` is therefore untargeted: read it as text.
- `issue_subscriptions` shows what you listen to, with open request ids per issue.

## Writing on issues

- Open items: a **table** (`# | Item | What's left | Status`), never a `- [ ]` checklist.
- Posting with `gh` directly (status comments, consolidation): start with the same `🤖 <tag> ·` prefix as `issue_reply` and end with `<!-- issue-channel:bot -->`, or build it with `node $ISSUECHAN_DIR/core/reply-format.mjs`. On Linear use the tools or `scripts/linear.mjs`, which add the invisible marker `[//]: # (issue-channel:bot)`.
- Images and files attached to an issue need auth: `scripts/attachment.sh <url> <out-file>` (GitHub `user-attachments` via the `gh` token; Linear `uploads.linear.app` via the Linear token), then read the file.

## Changing or deleting what's there

- Back up before rewriting or deleting: `node scripts/backup-issue.mjs <ref>` saves the issue and all comments to `~/.local/state/issue-channel/backups/`. Back up **again** right before deleting if comments arrived since the last backup.
- Delete only what the user asked for, after the replacement content is posted.
- Consolidating an issue (the user's "consolidate" request): follow [reference/consolidate.md](reference/consolidate.md).
- Linear deletions: replies before their parent; deleting a parent also deletes its whole thread, including the user's replies in it. Deleting another user's comment needs `admin`, which an app-actor token never has. Details in [reference/linear.md](reference/linear.md).

## Linear quick facts

- The agent acts as the user by default (`LINEAR_ACTOR=user` in `linear.env`): its replies, 👀 and ✅ show as the user, and Linear doesn't notify the user about them. The marker keeps them out of your own input.
- `scripts/linear.mjs` covers what the MCP tools don't: `create`, `issue`, `comment`, `edit-comment`, `delete-comment`, `set-description`, `set-state`, `whoami`. Don't hand-write GraphQL for these.
- More in [reference/linear.md](reference/linear.md).

## Restarting or compacting yourself

"CLM-compact", "compact yourself" or "restart yourself" means this section, from the terminal or a `/bot`, with or without an issue. It is not Claude Code's built-in `/compact`, which only the user can type.

To reload the channel, or to shrink your context (CLM-compact: you edit a full mirror of your own context, block by block, before the restart) and continue in the same pane, use `spawn/restart-agent.sh`, detached, with `--then`. Rules and commands: [reference/ops.md](reference/ops.md#restart-or-compact-yourself).

## Operating the channel

Which code runs, finding the channel process, other sessions: [reference/ops.md](reference/ops.md).
