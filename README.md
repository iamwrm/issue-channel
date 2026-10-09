# issue-channel

Talk to a running Claude Code session through a GitHub issue. Comment `/bot …` on an issue the session listens to. The comment, plus every new or edited comment since the last delivery, is pushed into the session, whether the agent is idle or busy. Design, decisions and validation: [`DESIGN.md`](DESIGN.md). Backlog (Codex support, hardening): [`BACKLOG.md`](BACKLOG.md).

```
GitHub ──signed webhook──► Cloudflare tunnel ──► server (container, SQLite)
                                                    ▲ long-poll /api (API key)
                    Claude Code ◄── stdio ── issuechan (MCP: core/ + adapters/claude-code, spawned by Claude Code)
```

- `server/`: dependency-free Node 24 server (`node:sqlite`). It verifies `X-Hub-Signature-256`, stores **every** event (raw payload plus extracted columns, deduplicated by delivery id), and serves a key-protected long-poll API with structured filters (no raw SQL).
- `core/`: the harness-neutral issuechan MCP server (`issuechan.mjs`, pure logic in `lib.mjs`, `gh` calls in `github.mjs`). Each harness plugs in through a small adapter in `adapters/<harness>/` that says how a delivery enters the session (see [`adapters/README.md`](adapters/README.md)). Claude Code uses `adapters/claude-code/`: a [channel](https://code.claude.com/docs/en/channels-reference). Codex uses `adapters/codex/`: user input through the Codex app-server ([launch](adapters/codex/README.md)). `channel/channel.mjs` and `channel/reply-format.mjs` are shims for the old paths. The `issue_subscribe` / `issue_unsubscribe` / `issue_subscriptions` tools let the agent listen to issues, `issue_done` marks requests finished (👀 → 🚀), and `issue_reply` posts replies as a plain one-line summary prefixed with who wrote it (see [Reply format](#reply-format)), then a clickable **Full reply** toggle (`<details>`) with the full text, plus the bot marker. Comments carrying the `<!-- issue-channel:bot -->` marker, and comments by non-allowlisted authors, are ignored.
- `session-fork/session-fork.mjs`: fork a Claude Code session log into an edited copy that `clauded --resume <id>` loads (CLM-style context editing, applied offline). `mirror` prints the session as numbered turns, `fork <session> <plan.json>` replaces or drops whole turns and adds notes, and `handoff` copies the issuechan subscription state to the fork. Used by the "replace myself" and "dispatch" prompts in `PROMPTS.md`; details in [`session-fork/README.md`](session-fork/README.md).
- `spawn/spawn-agent.sh`: start a new agent in its own herdr tab, launched with the required `clauded` flags, and have it listen to an issue under its own session name. See [`spawn/README.md`](spawn/README.md).
- `deploy/issue-channel.sh`: plain `sudo docker` deployment, with the server container and a `cloudflared` container on a private network.

## Deploy (this host)

```sh
# one-time: Cloudflare login + tunnel (cloudflared runs from its container image)
cf() { sudo docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/work -v "$HOME/.cloudflared:/work/.cloudflared" cloudflare/cloudflared:latest "$@"; }
cf tunnel login                                   # open the URL, pick the zone, Authorize
cf tunnel create issue-channel
cf tunnel route dns issue-channel issue-channel.example.com

deploy/issue-channel.sh init issue-channel.example.com   # secrets + tunnel config in ~/.local/share/issue-channel
deploy/issue-channel.sh build
deploy/issue-channel.sh up
deploy/issue-channel.sh status                         # local + public /healthz
deploy/issue-channel.sh webhook-add iamwrm/mainbot     # GitHub webhook: issues + issue_comment
```

The containers use `--restart unless-stopped`, so they come back after a reboot. The DB is at `~/.local/share/issue-channel/events.db`. `.env` in the same directory holds `WEBHOOK_SECRET` and `API_KEY` (mode 0600, never commit it).

## Use from Claude Code

```sh
npm ci   # in projects/issue-channel
clauded mcp add -s user issuechan -- node "$PWD/adapters/claude-code/channel.mjs"
```

An older config that runs `…/channel/channel.mjs` keeps working through the shim.

Then add [`adapters/claude-code/CLAUDE.snippet.md`](adapters/claude-code/CLAUDE.snippet.md) to `~/.claude/CLAUDE.md`. It is **required**: Claude Code labels channel messages that arrive mid-turn as external input, and without this note Claude declines to act on them. The note is safe because only signed webhooks from allowlisted authors get through.

Start a session with the channel loaded. Custom channels need the development flag during the research preview, and it only works in interactive sessions:

```sh
clauded --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan
```

Then say: *"create a new issue in iamwrm/xxx and listen to it"*. The repo needs the webhook (`webhook-add`).

| Env (channel) | Default |
|---|---|
| `ISSUECHAN_URL` | `http://127.0.0.1:8787` (use `https://issue-channel.example.com` from another machine) |
| `ISSUECHAN_API_KEY` | `API_KEY` from `ISSUECHAN_ENV_FILE` (`~/.local/share/issue-channel/.env`) |
| `ISSUECHAN_SESSION` | `default`; also settable via `issue_subscribe({session})` |
| `ISSUECHAN_ALLOWED_AUTHORS` | the repo owner |
| `ISSUECHAN_REACTION` | `eyes`: the channel adds 👀 to each delivered `/bot` comment through the local `gh` login; set it to empty to disable |
| `ISSUECHAN_DONE_REACTION` | `rocket`: replaces 👀 when the job is done (GitHub has no ✅ reaction); set it to empty to disable |
| `ISSUECHAN_RESUME_DELAY_MS` | `3000`: after `--resume` or `/mcp` reconnect, how long auto-resume waits after the MCP `initialized` handshake before delivering, because Claude Code drops channel notifications that arrive before it registers its listener |

### `/bot` rules

- A **newly created** comment whose text starts with `/bot` triggers a delivery: the buffered new/edited comments (and issue-body edits) since the last delivery, in order. Edits never trigger, including edits of a `/bot` comment. They wait in the buffer for the next `/bot`.
- An edit of a comment the agent has already seen is delivered with a diff against the version the agent saw, plus the full new text. An edit that restores exactly what the agent saw is dropped. Deleting a comment the agent has already seen is reported. Deleting one it hasn't seen just drops it.
- `/bot <name>` (a single token on the first line) targets a named session. If `<name>` is not an active session on that issue, the comment counts as untargeted (for example `/bot hi`).
- Idle session: Claude starts a new turn. Busy session: the message lands after the current tool call, inside the same turn. Text Claude is already streaming is not interrupted.
- Request lifecycle: 👀 when a `/bot` is delivered, 🚀 when the agent marks it done (`issue_reply` with `done` defaulting to true, or `issue_done`). Open requests are saved with the subscription. A deleted comment, or a 👀 that's already gone, is tolerated.
- Subscriptions are saved per agent session (Claude Code: `CLAUDE_CODE_SESSION_ID`, in `~/.local/state/issue-channel/`). They are restored automatically after `/mcp` reconnect or `clauded --resume`/`--continue`, from the last delivered trigger, so comments made while the channel was down are not lost. A new session starts with no subscriptions.

### Reply format

Every reply starts with `🤖 <tag> · <summary>`, so replies from different sessions on the same GitHub account can be told apart:

| issuechan session | agent session id | first line |
|---|---|---|
| `default` | Claude Code `c17a1e9d-…` | `🤖 cc:c17a1e9d · <summary>` |
| `extract` | Claude Code `c17a1e9d-…` | `🤖 extract · cc:c17a1e9d · <summary>` |
| `extract` | none | `🤖 extract · <summary>` |
| `default` | none | `🤖 <summary>` |

The name is what `/bot <name>` targets. `<agent>:<id8>` comes from `resolveAgent()` in `core/lib.mjs`: `ISSUECHAN_AGENT_ID=<agent>:<id>` if set, otherwise the first match in the adapter's `agentEnv` table (Claude Code: `cc` ← `CLAUDE_CODE_SESSION_ID`). A new harness declares its own in its adapter. The same id names the saved state file (`<agent>-<id>.json`). The bot marker stays the last line, so the self-filter is unaffected.

Comments posted with `gh` directly should use the same format: `node core/reply-format.mjs --summary "…" --body-file reply.md | gh issue comment N -R owner/name -F -`. For hand-written comments (such as a live status comment), start with the same `🤖 <tag> ·` prefix and end with the marker.

## API

All `/api/*` routes need `Authorization: Bearer $API_KEY`.

| Route | |
|---|---|
| `POST /webhook/github` | GitHub only (HMAC signature) |
| `GET /healthz` | no auth |
| `GET /api/cursor` | `{seq}`: latest event |
| `POST /api/events/query` | `{since, timeout≤90, limit≤500, include_payload, filter}` → `{events, next}`; long-polls until a match or timeout |
| `GET /api/events?repo=&issue=&event=&action=&author=&since=&timeout=` | same, query-string form |
| `GET /api/events/:seq` | one event with its full payload |
| `GET/PUT/DELETE /api/subscriptions` | session registry used for `/bot <name>` |

Filter keys: `repo`, `issue`, `event`/`action`/`author` (a string or a list), `title`/`body` as `{contains|like|regex: "..."}`, and `exclude_body_contains`.

```sh
curl -s -H "Authorization: Bearer $API_KEY" https://issue-channel.example.com/api/events/query \
  -d '{"since":0,"timeout":60,"filter":{"repo":"iamwrm/mainbot","issue":10,"body":{"regex":"^/bot"}}}'
```

## Test

```sh
npm ci && node --test   # in projects/issue-channel: server, core, adapters, session-fork
```
