# issue-channel backlog

Open work, with stable ids that issues link to ([D14](docs/DECISIONS.md#d14-the-repo-is-the-source-of-truth-issues-are-disposable-working-surfaces)). Mark an item **done** with a date instead of deleting it right away.

| Id | Item | Status |
|---|---|---|
| B1 | [Subscriptions lost after `/resume` inside the TUI](#b1-subscriptions-lost-after-resume-inside-the-tui) | Open |
| B2 | [`ctx report` right after the switch](#b2-ctx-report-right-after-the-switch) | Small |
| B3 | [Stronger self-compaction](#b3-stronger-self-compaction) | Idea |
| B4 | [Restart and live-context for Codex and pi](#b4-restart-and-live-context-for-codex-and-pi) | Planned |
| B5 | [Agent spawning beyond restart and compaction](#b5-agent-spawning-beyond-restart-and-compaction) | Not specified |
| B6 | [Rebuild the server image from `main`](#b6-rebuild-the-server-image-from-main) | Optional |
| B7 | [Codex support via app-server bridge](#b7-codex-support-via-app-server-bridge-turnstart--turnsteer) | Design |
| B8 | [Codex GUI live test](#b8-codex-gui-live-test-managed-daemon-done) | Done 2026-10-11 |
| B9 | [Hardening](#b9-hardening) | Open |

## B1. Subscriptions lost after `/resume` inside the TUI

A Claude Code session started fresh and then switched with `/resume` to an older conversation keeps the fresh session id in its issuechan channel, so the channel loads the fresh (empty) subscription state while the conversation continues under the old id. Seen three times on 2026-10-10/11 (bot_01 after a reboot, bot_02, bot_01 again). `restart-agent.sh` is not affected (it starts the process with `--resume <id>`). Details: [iamwrm/mainbot#43](https://github.com/iamwrm/mainbot/issues/43) and [`adapters/claude-code/README.md`](adapters/claude-code/README.md). Until it's fixed: after any restart, run `issue_subscriptions` and resubscribe from the old `cc-<id>.json`.

## B2. `ctx report` right after the switch

The new session's first request is only written to its log when it finishes, so `ctx report` run as the very first command after the switch says "not measured yet"; a second run a moment later works. Change the message to "run it again in a moment", and have the `--then` text ask for the report after one tool call.

## B3. Stronger self-compaction

The compactions so far kept every request and reply and only trimmed tool output (−45%, then −7%; dropping 190 reasoning blocks saved almost nothing). Larger savings need finished exploratory turns dropped whole, with one `[[NOTE]]` per finished task (results, PRs, commits). Add that as guidance to the live-context skill, with a realistic test.

## B4. Restart and live-context for Codex and pi

`spawn/restart-agent.sh` (restart in place, optionally into a CLM-compacted fork) and the `live-context` skill (`ctx`) support Claude Code only. Add **Codex** and **pi**: per harness, how to exit and resume a session in a pane, where its session log lives (for compaction a session-fork equivalent is needed), its startup dialogs, and how to find its issuechan process. Requested on Linear REN-108.

## B5. Agent spawning beyond restart and compaction

Open topic from Linear REN-108; not specified yet.

## B6. Rebuild the server image from `main`

Not needed for any change so far; optional so the running image matches `main`.


## B7. Codex support via app-server bridge (turn/start + turn/steer)

Follow-up to [`DESIGN.md`](DESIGN.md). Add Codex support to issue-channel through a **Codex app-server bridge**. Claude Code support uses a channel ([`DESIGN.md`](DESIGN.md)). Codex has no channel equivalent, and its background hooks can't wake an idle session ("Finishing a background hook doesn't start a new turn").

### Design

```
 GitHub ─► issue-channel server (SQLite, tunnel, key)
                     │ long-poll /bot
                     ▼
            issuechan-codex bridge ───┐  JSON-RPC client #2
                                      ▼
   codex app-server --listen unix://   ◄─── codex --remote unix://   (user's TUI, client #1)
          thread thr_X
   bridge: thread/resume thr_X (subscribe) → track turn/started, turn/completed, thread/status/changed
     /bot arrives:
       idle    → turn/start  {threadId, input}
       active  → turn/steer  {threadId, input, expectedTurnId}
       steer fails ("no active turn") → retry as turn/start
```

- `turn/steer` appends **user input** to the in-flight turn, so the mid-turn trust problem seen with Claude channels probably doesn't apply.
- Bind a session by registering the thread id with the bridge when the agent creates or subscribes to the issue.

### Validate first
- [ ] Two clients on one thread: does the `--remote` TUI render turns started or steered by the bridge?
- [ ] Busy/idle/burst/long-idle matrix, as in the Claude validation in [`DESIGN.md`](DESIGN.md#validation-2026-10-08-claude-code-21284-via-claude-tmux) (tmux).
- [ ] `unix://` socket transport (WebSocket is "experimental and unsupported").

### Fallback
A Codex hook-based provider: a Stop hook that long-polls the issue-channel server for idle waits, plus an async `PostToolUse` hook for mid-turn steering. This is weaker. Idle waiting is bounded by the hook timeout, and the hooks need `/hooks` trust or `--dangerously-bypass-hook-trust`.

Refs: https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/hooks

## B8. Codex GUI live test (managed daemon): done

**Status: done** (marked done by the user on Linear REN-107, 2026-10-11). The table below is kept as the checklist for re-testing.

The Codex adapter supports the managed app-server daemon that the Codex GUI and ChatGPT Remote attach to (#31, setup in [`adapters/codex/README.md`](adapters/codex/README.md#with-the-codex-gui-managed-daemon)). It has been checked live against a real `codex app-server`, but not with the GUI itself (#22, item 3).

| Step | What | Pass if |
|---|---|---|
| 1 | Merge #31, or check out `codex-managed-daemon` (the config points at the main checkout) | — |
| 2 | Add the `[mcp_servers.issuechan]` block from the README to `~/.codex/config.toml`, then `codex app-server daemon restart` | The daemon is up again (`codex app-server daemon version`) |
| 3 | Attach the GUI to this box (Remote SSH), open a thread, ask the agent to `issue_subscribe` | Listening reply tagged `codex:<id8>` |
| 4 | Post a `/bot` while the agent is idle | The GUI shows it live as a user message and the agent replies |
| 5 | Post a `/bot` while the agent is busy (e.g. running `sleep 25`) | Steered into the running turn and shown live, as in the TUI test (#29) |
| 6 | Optional: trigger an approval in the GUI | Your click decides it; issuechan no longer declines it first |
| 7 | Optional: `codex app-server daemon restart`, reopen the thread, post a `/bot` | Delivered without asking the agent to subscribe again |


## B9. Hardening

- Pin the `cloudflare/cloudflared` image version in `deploy/issue-channel.sh` instead of `:latest`.
- The `regex` filter runs patterns sent by API-key holders. Add a length cap or a timeout to avoid catastrophic backtracking.
- Live-test `/bot <name>` targeting between two concurrent sessions.
