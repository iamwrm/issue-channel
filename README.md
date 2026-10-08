# issue-channel

Talk to a running Claude Code session through a GitHub issue. Comment `/bot …` on an issue the session listens to. The comment, plus every new or edited comment since the last delivery, is pushed into the session, whether the agent is idle or busy. Design and validation: [#9](https://github.com/iamwrm/mainbot/issues/9). Codex support is backlogged in [#10](https://github.com/iamwrm/mainbot/issues/10).

```
GitHub ──signed webhook──► Cloudflare tunnel ──► server (container, SQLite)
                                                    ▲ long-poll /api (API key)
                    Claude Code ◄── stdio ── issuechan channel (MCP, spawned by Claude Code)
```

- `server/`: dependency-free Node 24 server (`node:sqlite`). It verifies `X-Hub-Signature-256`, stores **every** event (raw payload plus extracted columns, deduplicated by delivery id), and serves a key-protected long-poll API with structured filters (no raw SQL).
- `channel/`: the Claude Code [channel](https://code.claude.com/docs/en/channels-reference). The `issue_subscribe` / `issue_unsubscribe` / `issue_subscriptions` tools let the agent listen to issues. Comments carrying the `<!-- issue-channel:bot -->` marker, and comments by non-allowlisted authors, are ignored.
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
cd channel && npm ci
clauded mcp add -s user issuechan -- node "$PWD/channel.mjs"
```

Then add [`channel/CLAUDE.snippet.md`](channel/CLAUDE.snippet.md) to `~/.claude/CLAUDE.md`. It is **required**: Claude Code labels channel messages that arrive mid-turn as external input, and without this note Claude declines to act on them. The note is safe because only signed webhooks from allowlisted authors get through.

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

### `/bot` rules

- A comment whose text starts with `/bot` triggers a delivery: the buffered new/edited comments (and issue-body edits) since the last delivery, in order.
- `/bot <name>` (a single token on the first line) targets a named session. If `<name>` is not an active session on that issue, the comment counts as untargeted (for example `/bot hi`).
- Idle session: Claude starts a new turn. Busy session: the message lands after the current tool call, inside the same turn. Text Claude is already streaming is not interrupted.
- The channel resumes from the last delivered trigger when a session re-subscribes, so comments made while it was down are not lost.

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
(cd server && node --test)
(cd channel && npm ci && npm test)
```
