# issue-channel backlog

## Codex support via app-server bridge (turn/start + turn/steer)

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
- [ ] Busy/idle/burst/long-idle matrix, as in the Claude validation in [`DESIGN.md`](DESIGN.md#validation-2026-10-08-claude-code-21284-via-clauded-tmux) (tmux).
- [ ] `unix://` socket transport (WebSocket is "experimental and unsupported").

### Fallback
A Codex hook-based provider: a Stop hook that long-polls the issue-channel server for idle waits, plus an async `PostToolUse` hook for mid-turn steering. This is weaker. Idle waiting is bounded by the hook timeout, and the hooks need `/hooks` trust or `--dangerously-bypass-hook-trust`.

Refs: https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/hooks

## Codex GUI live test (managed daemon)

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


## Hardening

- Pin the `cloudflare/cloudflared` image version in `deploy/issue-channel.sh` instead of `:latest`.
- The `regex` filter runs patterns sent by API-key holders. Add a length cap or a timeout to avoid catastrophic backtracking.
- Live-test `/bot <name>` targeting between two concurrent sessions.
