# Codex adapter

Codex has no channel push, so issuechan hands each `/bot` to the agent's thread as **user input** through the Codex app-server: `turn/start`, which starts a turn when the agent is idle and **steers** the running turn when it is busy (same turn id back; the input lands at the next model request, after any running tool call).

```
  herdr tab: codex --remote unix://$SOCK            (the agent's TUI, renders every turn)
                      │
  codex app-server --listen unix://$SOCK ── thread T ──► spawns one MCP server per thread
                      ▲                                        │
                      └── WebSocket ── issuechan (adapters/codex/mcp.mjs, bound to T)
                           thread/resume T, turn/start {T, "/bot …"}
```

## Launch

```sh
SOCK=$HOME/.local/state/issue-channel/codex/app-server.sock   # its directory must be mode 700
mkdir -p "$(dirname "$SOCK")" && chmod 700 "$(dirname "$SOCK")"
IC=/path/to/issue-channel               # after `npm ci` there

codex app-server --listen "unix://$SOCK" \
  -c 'mcp_servers.issuechan.command="node"' \
  -c "mcp_servers.issuechan.args=[\"$IC/adapters/codex/mcp.mjs\"]" \
  -c "mcp_servers.issuechan.env={ISSUECHAN_CODEX_SOCK=\"$SOCK\"}" \
  -c 'mcp_servers.issuechan.default_tools_approval_mode="approve"' &

codex --remote "unix://$SOCK" -m gpt-6.1-sol -c model_reasoning_effort=medium
```

Then ask the agent to `issue_subscribe` (with a `session` name) as usual. `spawn-agent.sh --harness codex` is planned (#22, open item 7).

| Setting | Why |
|---|---|
| `ISSUECHAN_CODEX_SOCK` in `mcp_servers.issuechan.env` | Codex gives MCP servers only an allowlisted environment (`HOME`, `PATH`, `USER`, …), so the socket path must be passed explicitly. The issue-channel API key is read from `~/.local/share/issue-channel/.env` as usual. |
| `default_tools_approval_mode = "approve"` | Codex blocks MCP tool calls that need approval; with `approvalPolicy: never` they fail ("MCP tool call requires approval"). |
| Socket directory mode 700 | The app-server refuses a socket whose parent other users could write. |
| `ISSUECHAN_CODEX_RETRY_MS` (optional) | Waits between delivery attempts, default `1000,2000,5000,10000,20000`. After that the core redelivers with its poll backoff; a `/bot` is never dropped. |

## How it binds
- Codex passes the thread id only with tool calls (`_meta.threadId`), not in the environment. The first tool call binds the process to that thread: replies are tagged `🤖 <session> · codex:<id8>`, and state goes to `~/.local/state/issue-channel/codex-<thread id>.json`.
- The app-server runs one MCP server process per thread, so a binding never changes.
- `--listen unix://PATH` turns PATH into a symlink to a short socket under `/tmp/codex-daemon-<uid>/`; the adapter connects to the symlink's target, because long paths exceed the unix socket limit (`connect EINVAL`).

## Not yet
- No auto-resume after the app-server restarts: subscriptions are saved per thread, but the new MCP process learns its thread only at the agent's first tool call. Ask the agent to `issue_subscribe` again (it resumes from the saved cursor).
- `core/reply-format.mjs` can't tag `gh` comments from Codex (no thread id in the shell env); use `issue_reply`.
- MCP server stderr goes to Codex's log database (`~/.codex/logs_2.sqlite`, table `logs`, target `codex_rmcp_client::stdio_server_launcher`).

## Validation (2026-10-09, codex-cli 0.161.0, gpt-6.1-sol medium)
| Case | Result |
|---|---|
| Subscribe + listening reply from a `codex --remote` agent | ✅ `🤖 codextest · codex:01a12114 · Listening as session codextest` |
| Idle `/bot` | ✅ shown in the TUI as a user message about 2 s after the comment was posted |
| Busy: second `/bot` while the first turn runs `sleep 25` | ✅ steered into the same turn; the agent acknowledged it before the command finished, replied `ALPHA BRAVO`, and marked both done (👀 → 🚀) |
| App-server unreachable / long socket path | ✅ before the fix the `/bot` was dropped (`connect EINVAL`); now covered by `codex.test.mjs` |
