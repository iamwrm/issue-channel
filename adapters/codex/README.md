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

### With the Codex GUI (managed daemon)
The Codex desktop app and ChatGPT's Remote (SSH) attach to the **managed app-server daemon** at `~/.codex/app-server-control/app-server-control.sock` (a symlink into `/tmp/codex-daemon-<uid>/`; the same WebSocket-on-unix protocol as `--listen`). The app starts the daemon itself (`codex app-server daemon bootstrap|start`), so `-c` flags don't reach it: register issuechan in `~/.codex/config.toml`:

```toml
[mcp_servers.issuechan]
command = "node"
args = ["/path/to/issue-channel/adapters/codex/mcp.mjs"]
default_tools_approval_mode = "approve"
```

No `env` is needed: without `ISSUECHAN_CODEX_SOCK` the adapter uses the daemon socket. Run `codex app-server daemon restart` after editing the config, open a thread in the GUI, and ask the agent to `issue_subscribe`.

This entry also makes a plain `codex` (with its own embedded app-server) start issuechan. Those deliveries then fail safely and are retried: the adapter only sends `turn/start` to a thread already loaded in the app-server it talks to, and never resumes one itself, so no turn runs where no UI shows it. Use `codex --remote unix://…` or the GUI for issuechan agents.

| Setting | Why |
|---|---|
| `ISSUECHAN_CODEX_SOCK` in `mcp_servers.issuechan.env` | The app-server to deliver through. Default: the managed daemon socket under `~/.codex` (`CODEX_HOME` is not honored: Codex gives MCP servers only an allowlisted environment, `HOME`, `PATH`, `USER`, …). Set it for a `--listen` app-server like the one above. The issue-channel API key is read from `~/.local/share/issue-channel/.env` as usual. |
| `default_tools_approval_mode = "approve"` | Codex blocks MCP tool calls that need approval; with `approvalPolicy: never` they fail ("MCP tool call requires approval"). |
| Socket directory mode 700 | The app-server refuses a socket whose parent other users could write. |
| `ISSUECHAN_CODEX_BIND_MS` (optional) | Waits between startup binding attempts (below), default `500,1000,2000`. |
| `ISSUECHAN_CODEX_RETRY_MS` (optional) | Waits between delivery attempts, default `1000,2000,5000,10000,20000`. After that the core redelivers with its poll backoff; a `/bot` is never dropped. |

## How it binds
- Codex passes the thread id only with tool calls (`_meta.threadId`), not in the environment. The first tool call binds the process to that thread: replies are tagged `🤖 <session> · codex:<id8>`, and state goes to `~/.local/state/issue-channel/codex-<thread id>.json`.
- The app-server runs one MCP server process per thread, so a binding never changes. A bound process claims its thread in `~/.local/state/issue-channel/codex-claims/<thread id>` (its pid).
- **After an app-server restart** (the GUI restarts or updates the daemon), the new MCP process binds before any tool call, so its saved subscriptions resume on their own. Codex spawns a thread's MCP process while loading the thread, so the thread is already in `thread/loaded/list` (measured: within ~20 ms of spawn), and the process's cwd is the thread's cwd. The process binds only when exactly **one** loaded thread with its cwd is unclaimed by a live process; when that is ambiguous (two threads of the same project loaded at once, one of them never bound), it waits for the first tool call as before. A `/bot` posted meanwhile is not lost: it is delivered once bound.
- **Approvals and other server requests** (command or patch approval, user input, auth refresh) go to *every* client attached to the thread, and the first answer wins. issuechan never answers them, so the GUI's or TUI's prompt decides. (Before, issuechan replied with an error at once, which the app-server took as the answer: a command the user approved 3 s later had already been declined.)
- `--listen unix://PATH` turns PATH into a symlink to a short socket under `/tmp/codex-daemon-<uid>/`; the adapter connects to the symlink's target, because long paths exceed the unix socket limit (`connect EINVAL`).

## Not yet
- Auto-resume after a restart is skipped when the binding is ambiguous (see above); then the agent's first tool call binds and resumes it, or ask it to `issue_subscribe` again (it resumes from the saved cursor).
- Not yet tested with the GUI itself: whether it renders a turn started or steered by another client live (the TUI does).
- `core/reply-format.mjs` can't tag `gh` comments from Codex (no thread id in the shell env); use `issue_reply`.
- MCP server stderr goes to Codex's log database (`~/.codex/logs_2.sqlite`, table `logs`, target `codex_rmcp_client::stdio_server_launcher`).

## Validation (2026-10-09, codex-cli 0.161.0, gpt-6.1-sol medium)
| Case | Result |
|---|---|
| Subscribe + listening reply from a `codex --remote` agent | ✅ `🤖 codextest · codex:01a12114 · Listening as session codextest` |
| Idle `/bot` | ✅ shown in the TUI as a user message about 2 s after the comment was posted |
| Busy: second `/bot` while the first turn runs `sleep 25` | ✅ steered into the same turn; the agent acknowledged it before the command finished, replied `ALPHA BRAVO`, and marked both done (👀 → 🚀) |
| App-server unreachable / long socket path | ✅ before the fix the `/bot` was dropped (`connect EINVAL`); now covered by `codex.test.mjs` |

## Validation of the managed-daemon support (2026-10-10, codex-cli 0.161.0, gpt-6.1-sol medium; no GUI)
| Case | Result |
|---|---|
| `codex app-server daemon start` → our client on `~/.codex/app-server-control/app-server-control.sock` | ✅ `initialize`, `thread/list`, `thread/loaded/list` work over the symlinked socket |
| Approval with two clients (a "GUI" client that accepts after 3 s, plus issuechan) | ❌ before: issuechan's instant error won and the command was not run. ✅ after: the GUI's accept wins, the command runs. |
| Restart, then resume one subscribed thread | ✅ the issuechan MCP process bound to it at start (claim file written) |
| Restart, then resume two threads with the same cwd | ✅ not bound (ambiguous); falls back to the first tool call |
| Unit/integration tests | ✅ 39/39 (`node --test`), incl. approvals left unanswered, the default socket, startup binding and its ambiguity, and no delivery to a thread that isn't loaded |
