# Claude Code adapter

issuechan delivers each `/bot` into a running Claude Code session as a channel notification (`notifications/claude/channel`), which the session shows as a `<channel source="issuechan" …>` message.

```sh
clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan [--resume <session-id>]
```
`channel.mjs` is the MCP server (`issuechan` in `~/.claude.json`); `adapter.mjs` is the Claude Code part; `CLAUDE.snippet.md` is the instruction block for `~/.claude/CLAUDE.md`.

## Which session the channel thinks it is
The channel identifies its session by `CLAUDE_CODE_SESSION_ID`, which Claude Code puts in the MCP server's environment **when it spawns the server**. That id:
- tags every reply (`🤖 <name> · cc:<id8>`);
- names the state file `~/.local/state/issue-channel/cc-<id>.json`: subscriptions, cursors, open 👀 requests;
- drives auto-resume: on start, the channel re-subscribes to everything in that file, from the saved cursor, so a `/bot` posted while it was down is still delivered.

## Pitfall: `/resume` inside the TUI leaves the channel on the wrong session
Starting `clauded` without `--resume` creates a new session id, and the MCP server is spawned with it. Switching to an older conversation with `/resume` inside the TUI does **not** respawn the MCP server, so the channel keeps the new, empty id:

| What you see | Why |
|---|---|
| `issue_subscriptions` shows `(none)`, nothing is delivered, no error | auto-resume looked in `cc-<new id>.json`, which doesn't exist |
| Replies are tagged with an id that isn't the conversation's | the tag comes from the stale env id |
| `/bot` comments posted meanwhile are never delivered | nobody subscribes from the saved cursor in `cc-<old id>.json` |

Seen live on 2026-10-11: a host restart, then `clauded` + `/resume` of bot_02's conversation. The channel ran as `cc:5ea5d4cc` instead of `cc:a4cb5658`, listened to nothing, and a `/bot` on REN-107 went unanswered until the user asked whether the agent was still listening.

Reproduced in a throwaway session with an MCP probe that logs `CLAUDE_CODE_SESSION_ID` at spawn:

| Step | Id in the MCP server |
|---|---|
| `clauded` (fresh) | `2ba5b9f0`, the new session |
| `/resume 3f2dcee5` in the TUI | still `2ba5b9f0`: **stale** |
| `/mcp` → the server → Reconnect | `3f2dcee5`: correct |

### Avoid it
- **Resume from the shell:** `clauded … --resume <session-id>` (or `spawn/spawn-agent.sh --resume <id>`, or `spawn/restart-agent.sh`). The MCP server is then spawned with the right id and auto-resumes.
- **If you did use `/resume` in the TUI:** run `/mcp` → `issuechan` → **Reconnect** right away. The new server process gets the resumed id, reads `cc-<id>.json` and resumes every subscription from its saved cursor, including `/bot`s posted in between.

### Check after any restart or resume
1. Call `issue_subscriptions`. An empty or short list right after a resume means the channel is on the wrong id.
2. Compare the id in the reply tag (or `tr '\0' '\n' < /proc/<channel pid>/environ | grep CLAUDE_CODE_SESSION_ID`) with the conversation's id (`$CLAUDE_CODE_SESSION_ID` in the agent's own shell).
3. Fix with `/mcp` → Reconnect. Calling `issue_subscribe` again also restores listening, but under the wrong id it starts from **now**: `/bot`s posted while it was down are skipped. Read each issue's recent comments and answer any that are unanswered.
