# Harness adapters

issuechan has one transport-neutral engine (`core/engine.mjs`) with the same five tools for every harness: `issue_subscribe`, `issue_reply`, `issue_done`, `issue_unsubscribe`, `issue_subscriptions`. Claude Code and Codex use the thin MCP wrapper (`core/issuechan.mjs`); [Pi](pi/README.md) calls the engine directly from a native extension. An MCP adapter differs in these ways:

| | What | Claude Code (`claude-code/`) | Codex (`codex/`) |
|---|---|---|---|
| who | `agentEnv`: `[[agentTag, ENV_VAR]]` holding the session id (reply tag, state file name), or `agentFromCall(params)` when the harness passes it only with tool calls | `cc` ← `CLAUDE_CODE_SESSION_ID` | `codex` ← the first tool call's `_meta.threadId` |
| how | `deliver(mcp, { content, meta }, { agent })`: push one `/bot` delivery into the session; throw to have the core retry it | `notifications/claude/channel` | app-server `turn/start` / `turn/steer` |
| setup | `capabilities`, `arrival` (first instructions sentence), `resumeDelayMs` | `claude/channel` capability, `<channel source="issuechan">`, 3000 ms | none, "arrives as a user message", 0 |
| binding (optional) | `onBind(agent, { stateDir })` after a tool call binds; `agentAtStart({ stateDir })` to bind before any tool call, so saved subscriptions auto-resume | — | claims the thread; after an app-server restart, binds to the one unclaimed loaded thread in its cwd |

The rest (polling, `/bot` parsing and routing, edit diffs, state files, replies and 👀/🚀) lives in `core/` and must stay harness-neutral.

## Add a harness
1. `adapters/<harness>/adapter.mjs`: default-export the object above.
2. `adapters/<harness>/<entry>.mjs`: `await runIssuechan(adapter)`, and register it as the harness's MCP server.
3. Add the adapter to `adapters/index.mjs`, so `core/reply-format.mjs` recognizes its session id.
4. Put an integration test next to it (see `claude-code/channel.test.mjs`).

## Native Pi extension

`pi/index.ts` registers the five tools directly and maps deliveries to `pi.sendUserMessage(..., { deliverAs: "steer" })`; installing MCP tools alone cannot provide inbound steering. `pi/durable.ts` owns the per-session inbox, on-disk receipt reconciliation and local single-owner guard. It reads current Pi session identity from the extension context, so no guessed Pi environment variable or `adapters/index.mjs` entry is needed. See [Pi setup](pi/README.md).

The engine API is `createIssueEngine({ agent, session, stateDir, deliver, onStatus })` → `start`, `stop`, `callTool`, `getStatus`, with exported `ISSUE_TOOLS` schemas. `deliver` must durably accept a delivery before resolving; throw to retry. `stop` aborts session-owned polling/retries and preserves saved subscriptions. Status identifies each subscription's mode and connection readiness. Keep all provider/routing/reaction logic in the shared engine.
