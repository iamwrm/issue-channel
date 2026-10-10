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

## Reloading the channel

- In the session's terminal: `/mcp` → reconnect `issuechan`. Subscriptions resume from the saved cursor.
- Or restart the whole session in place with herdr, from a **detached** script (your own turn has to end first): wait until `herdr agent get <pane>` reports `idle`/`done`, send `/exit`, wait until the agent is gone, then `herdr pane run <pane> "<launcher> --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan --resume <session id>"`, answer the dev-channel dialog, and finally `herdr agent prompt <pane> "<what to do next>"` so the resumed session continues. Under `set -o pipefail`, `herdr agent get` fails once the agent is gone; treat that as "gone", don't let it abort the script.
- Subscriptions are restored automatically after either; issues you subscribe to later start from "now" (see SKILL.md: Listening).

## Other sessions

`herdr agent list` shows the agents and their panes; `~/.local/state/issue-channel/cc-<session id>.json` holds each Claude Code session's subscriptions. Message another local session with your harness's agent messaging, or `herdr agent prompt <pane> "…"`, and say who you are and why.
