# issue-channel design

This file replaces GitHub issue #9, which held the design and validation while the project was in active development. Setup, usage, the `/bot` rules and the API are in [`README.md`](README.md). Codex support and hardening follow-ups are in [`BACKLOG.md`](BACKLOG.md).

## Goal

Turn a GitHub issue into a two-way chat channel with a running Claude Code agent. A small server receives GitHub issue webhooks, stores every event in a local SQLite database, and lets agent clients long-poll for new events.

## Intended workflow

1. In Claude Code, tell the agent: "create a new issue in repo `xxx` and listen to it."
2. The agent creates the issue and subscribes its session to it. The **issuechan** Claude Code channel then pushes `/bot` comments into the session.
3. The user adds comments to the issue. Ordinary comments are stored but do not wake the agent.
4. When a new comment starts with `/bot` or `/bot <session_name>`, the channel pushes every new and edited comment since the session's last delivery into the session. The agent then responds on the issue.
5. **Steering:** a `/bot` posted while the agent is still running reaches it mid-run, without waiting for the current turn to finish.

## Components

### 1. Webhook receiver

- HTTP endpoint for GitHub `issues`, `issue_comment` (created/edited/deleted) and `ping` events.
- Exposed to the internet through a **Cloudflare Tunnel** (`cloudflared`). The server itself binds only to localhost.
- **Authentication:**
  - Webhooks: verify `X-Hub-Signature-256` (HMAC-SHA256 with the webhook secret). Reject anything unsigned or with a bad signature.
  - Client/query API: require a separate API key (`Authorization: Bearer <key>`).
- Deduplicate by `X-GitHub-Delivery`, so GitHub redeliveries are idempotent.

### 2. Storage (local SQLite)

- Store **every** event GitHub sends as raw JSON, plus extracted columns for querying: delivery id, event type, action, repo, issue number, comment id, author, title, body, created/updated timestamps, and a monotonically increasing `seq` for cursors.
- WAL mode, so the webhook writer and long-poll readers don't block each other.

### 3. Long-poll query API

- A client can wait for any update on a given issue, or for a custom structured filter on title/body that the server compiles to parameterized SQL.
- Parameters: a `since=<seq>` cursor and a `timeout`. The request returns as soon as matching events exist, or empty on timeout. The response includes the next cursor.

### 4. Claude Code integration: a channel

Claude Code [channels](https://code.claude.com/docs/en/channels-reference) are used, not Stop/asyncRewake hooks. A channel is a stdio MCP server that Claude Code spawns and keeps alive for the whole session. It declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel` events.

- The **issuechan MCP server** (`core/issuechan.mjs`, run for Claude Code by `adapters/claude-code/channel.mjs`) long-polls the issue-channel server with this session's cursor. Each `/bot` batch becomes one notification: `content` holds the comments and `meta` holds `{repo, issue, seq, author, edited}`. Its `instructions` string explains the `<channel source="issuechan">` tag and the reply convention.
- **Launch:** `claude --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`. Custom channels aren't on the research-preview allowlist. The flag shows a confirmation screen and only works in interactive sessions, not `-p`. Keep the channel's MCP SDK on a protocol revision older than `2026-07-28` (or set `MCP_PROTOCOL_NEGOTIATION=legacy`), otherwise the channel does not register.
- **Trust note (required):** Claude Code labels a channel message that arrives *mid-turn* as external input. Without guidance, Claude declined to act on it (2 of 2 tests). The user's `CLAUDE.md` must state that `issuechan` is the user's own authenticated input path ([`adapters/claude-code/CLAUDE.snippet.md`](adapters/claude-code/CLAUDE.snippet.md)). The note is safe only because the server checks the webhook signature and the channel checks a commenter allowlist before anything reaches the session.
- **Session routing:** `/bot` goes to the default (or only) listener on the issue. `/bot <session_name>` targets a named session. Cursors and subscriptions are kept per session.

#### Why a channel instead of hooks

```
                         asyncRewake hooks         Channel
 moving parts            4 hooks + lock +          1 MCP server
                         listener + file queue
 re-arming               after every wake          none
 long idle               listener dies at timeout  lives with the session
 claude wrapper          ⚠ "third-party hooks,     no warning
                           ban risk"
 framing                 "Stop hook blocking       <channel source=…>
                          error…"                  queued message
```

Fallback if channels become unavailable (org policy or a preview change): an `asyncRewake` listener hook, re-armed from `SessionStart`/`UserPromptSubmit`/`PostToolBatch`/`Stop` with a `flock`, using a large `timeout`.

#### Validation (2026-10-08, Claude Code 2.1.284 via `claude`, tmux)

| Case | asyncRewake | Channel |
|---|---|---|
| Idle wake (fresh / after busy turns) | ✅ ~5s | ✅ ~5s |
| Idle 11.5 min, `timeout: 86400` | ✅ | n/a (the channel lives with the session) |
| Busy, sequential tool calls (7 msgs) | ✅ delivered in the same turn after the running tool | ✅ with the CLAUDE.md trust note (5/5); ⚠️ refused without it (0/2) |
| Busy, one 40s foreground tool | ✅ after the tool, same turn | ✅ same |
| Busy, text-only generation | after the turn → new turn | same |
| Burst of 3 msgs | ✅ in order, no loss/dupes | ✅ (#1 and #2 grouped together) |

Neither mechanism interrupts a running tool or a streaming reply. A message lands at the next point between tool calls, or at turn end. That is the same timing as a message the user types while Claude works.

## Decisions

- **Self-filter:** the agent's replies include a hidden marker (`<!-- issue-channel:bot -->`). Marked comments never trigger `/bot`, even when the bot posts as the user's own account.
- **Replies:** the agent posts replies through the local `gh` login (now via the channel's `issue_reply` tool, which adds the marker and a `🤖 <session> · <agent>:<id8>` prefix naming the session that wrote it). The server stays read-only toward GitHub and needs no GitHub token.
- **Query:** a structured JSON filter (repo, issue, event/action, author, title/body contains/LIKE/regex). No raw SQL.
- **Retention:** keep all events forever, and prune by hand if that is ever needed. This also keeps deleted comments recoverable from `events.db`.
- Later decisions (reactions, reply format, auto-resubscribe, edit/delete handling) are documented as current behavior in the README's `/bot` rules.

## Acceptance

- [x] Signed GitHub webhook → stored row. An unsigned or wrongly signed request → 401, with nothing stored.
- [x] An API call without the key → 401.
- [x] A comment containing the bot marker never triggers `/bot`.
- [ ] A long poll on issue N returns within about 1s of a matching webhook, and returns empty on timeout. (Live delivery is "within seconds"; the 1s bound was not measured.)
- [x] End to end through the Cloudflare tunnel: comment `/bot hello` → the issuechan channel wakes the idle agent with the comment.
- [x] A `/bot` posted during a running turn reaches the agent before that turn ends (steer), and is acted on.
- [ ] The session stays wakeable after more than 1h idle. (Not explicitly tested; the longest recorded idle wake was just under an hour, on 2026-10-09.)

## History

- Developed inside the owner's orchestrator repo; commit ids below are from this repo's (extracted) history.
- Implemented in `463aee9` and deployed at `https://issue-channel.example.com` (server + `cloudflared` containers), with the webhook registered on the owner's orchestrator repo. Validated end to end there (issue #11): idle wake, mid-turn steer, comment edits and the bot-marker self-filter.
- Reactions, `issue_reply`, auto-resubscribe and edit diffs: `569de33` (developed live on #12).
- Prior art: `stop_hook_poller/`, a session-scoped Stop-hook wait for Codex, was removed in `d50a97c` (#13). Codex support is now planned as an app-server bridge (see BACKLOG.md).
