# Operating the channel

## Which code runs

- The issuechan channel is an MCP process the harness starts once per session: `node $ISSUECHAN_DIR/adapters/claude-code/channel.mjs` (Claude Code) or `adapters/codex/mcp.mjs` (Codex). It loads the code at start; edits to `core/` take effect only after it restarts.
- The server runs in the `issue-channel-server` container, built from `server/`: `deploy/issue-channel.sh build && deploy/issue-channel.sh restart && deploy/issue-channel.sh status`. A restart takes a few seconds; GitHub doesn't retry, so check the webhook's recent deliveries afterwards and redeliver failures.

## Finding your channel process

Node renames its process to `MainThread`, and `pgrep -f <path>` also matches the shell running it. Match on the command line of real processes:

```sh
for p in $(pgrep -f 'adapters/claude-code/channel.mjs'); do
  [ "$(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -d' ' -f1)" = node ] &&
    echo "$p $(tr '\0' '\n' </proc/$p/environ | grep CLAUDE_CODE_SESSION_ID)"
done
```

## Restart or compact yourself

Use `spawn/restart-agent.sh` (never hand-roll `/exit` + `--resume`). It waits until the agent is idle, so an agent can run it **on itself**, detached, as the last step of a turn:

```sh
# plain restart in place: same session and context, the channel reloads with the current code
setsid nohup $ISSUECHAN_DIR/spawn/restart-agent.sh --pane "$HERDR_PANE_ID" --session "$CLAUDE_CODE_SESSION_ID" \
  --name <herdr name> --then "<what to do once back>" > /tmp/restart.json 2> /tmp/restart.log < /dev/null &

# CLM-compact, then restart in place: edit your own context NOW (you still have all of it), then restart into the edit
node $ISSUECHAN_DIR/session-fork/session-fork.mjs mirror --full "$CLAUDE_CODE_SESSION_ID" --out live.md   # every block
#   … edit live.md with your normal edit tools (rules in its preamble and below) …
setsid nohup $ISSUECHAN_DIR/spawn/restart-agent.sh --pane "$HERDR_PANE_ID" --session "$CLAUDE_CODE_SESSION_ID" \
  --name <herdr name> --fork live.md --then "<what to do once back>" > /tmp/restart.json 2> /tmp/restart.log < /dev/null &
```

**Editing `live.md`** (CLM: the context is a file you edit; the edited file becomes the next session's context):
- Each `[[BLOCK bNNNN kind=…]]` is one prompt, reply, tool call, tool output or reasoning block. Delete a block to drop it; edit its text to shorten it. Edited tool output gets a visible "trimmed" marker.
- **Default: keep the user's requests and your replies; trim bulky tool output first;** drop whole stale exchanges (prompt and reply together). Use a `[[NOTE]]` (at a turn boundary) only to summarize what you removed. Deleting everything and writing one note is allowed, but it is a plain handoff: the next session treats its facts as hearsay.
- `kind=thinking` is your signed reasoning: keep or delete it, never edit it (its text is not shown, and the signature is what counts). Keep it unless it's in a span you drop.
- Attachments (reminders, tool lists) are not shown; they stay while their turn keeps any block.
- `restart-agent.sh --fork` only takes such a file, refuses it if the session moved on after the mirror (make a new one), and writes `live.diff.md`: what was kept, edited and dropped. Report those counts with the restart.

| Rule | Why (seen live, 2026-10-10) |
|---|---|
| Always pass `--then`: the resumed session doesn't know it was restarted | It just sits idle otherwise |
| Pass `--name`: herdr doesn't report an agent's name, so the script can't restore it by itself | `herdr agent get` has no name field |
| The turn that runs `mirror` and does the edit is dropped automatically (`--keep-last` keeps it) | Its mirror output quotes the blocks the edit drops: a "dropped" secret survived until this was fixed |
| Drop **every** block whose prompt, tool output or reply carries what must go, not just where it came from; never put it in a note | Later turns echoed it |
| A kept prompt with all its replies deleted reads as a request you never answered; a deleted prompt with kept replies reads as a gap (both are warnings in the diff) | POC E4, live L1 |
| Check after the restart: the reply tag shows the new session id (`cc:<fork id8>`), and ask for something the edit kept | That's how the tests verified it |
| Subscriptions, cursors and open 👀 requests move to the fork (`handoff`); the parent's state is parked as `cc-<id>.json.handed-off`. A `/bot` posted during the switch is delivered after the resume | Verified in every test |
| A restart takes about 8–14 s. Compaction saves what the edit drops | 58k → 42–51k tokens in the tests |
| Agents may ask before restarting themselves when the request comes as pasted text; a `/bot` from the user is the trusted way to ask | Seen in T3 |

Without herdr: `/mcp` → reconnect `issuechan` reloads just the channel (no compaction).

## Other sessions

`herdr agent list` shows the agents and their panes; `~/.local/state/issue-channel/cc-<session id>.json` holds each Claude Code session's subscriptions. Message another local session with your harness's agent messaging, or `herdr agent prompt <pane> "…"`, and say who you are and why.
