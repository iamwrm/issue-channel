# issue-channel

Talk to a running Claude Code session through a GitHub issue. Comment `/bot …` on an issue the session listens to. The comment, plus every new or edited comment since the last delivery, is pushed into the session, whether the agent is idle or busy. Design, decisions and validation: [`DESIGN.md`](DESIGN.md). Backlog (Codex support, hardening): [`BACKLOG.md`](BACKLOG.md).

```
GitHub ──signed webhook──► Cloudflare tunnel ──► server (container, SQLite)
                                                    ▲ long-poll /api (API key)
                    Claude Code ◄── stdio ── issuechan (MCP: core/ + adapters/claude-code, spawned by Claude Code)
```

- `server/`: dependency-free Node 24 server (`node:sqlite`). It verifies `X-Hub-Signature-256`, stores **every** event (raw payload plus extracted columns, deduplicated by delivery id), and serves a key-protected long-poll API with structured filters (no raw SQL).
- `core/`: the harness-neutral issuechan MCP server (`issuechan.mjs`, pure logic in `lib.mjs`, `gh` calls in `github.mjs`). Each harness plugs in through a small adapter in `adapters/<harness>/` that says how a delivery enters the session (see [`adapters/README.md`](adapters/README.md)). Claude Code uses `adapters/claude-code/`: a [channel](https://code.claude.com/docs/en/channels-reference). Codex uses `adapters/codex/`: user input through the Codex app-server ([launch](adapters/codex/README.md)). `channel/channel.mjs` and `channel/reply-format.mjs` are shims for the old paths. The `issue_subscribe` / `issue_unsubscribe` / `issue_subscriptions` tools let the agent listen to issues, `issue_done` marks requests finished (👀 → 🚀), and `issue_reply` posts replies as a plain one-line summary prefixed with who wrote it (see [Reply format](#reply-format)), then a clickable **Full reply** toggle (`<details>`) with the full text, plus the bot marker. Comments carrying the `<!-- issue-channel:bot -->` marker, and comments by non-allowlisted authors, are ignored.
- `session-fork/session-fork.mjs`: fork a Claude Code session log into an edited copy that `claude --resume <id>` loads (CLM-style context editing, applied offline). `mirror` prints the session as numbered turns; `mirror --full` writes the whole context as an editable file (one block per prompt, reply, tool call, output or signed reasoning), and `fork <session> <live.md>` turns the edited file into the new session (`fork <session> <plan.json>` still replaces or drops whole turns, for dispatch); and `handoff` copies the issuechan subscription state to the fork. Used by the "replace myself" and "dispatch" prompts in `PROMPTS.md`; details in [`session-fork/README.md`](session-fork/README.md).
- `spawn/spawn-agent.sh`: start a new agent in its own herdr tab, launched with the required `claude` flags, and have it listen to an issue under its own session name. See [`spawn/README.md`](spawn/README.md).
- `deploy/issue-channel.sh`: plain `sudo docker` deployment, with the server container and a `cloudflared` container on a private network.

## Quick start

You need Docker, Node 24, the [`gh` CLI](https://cli.github.com/) (logged in), `jq`, `openssl`, and Claude Code. Each person self-hosts: one server per GitHub account, running on the machine where the agents run.

```sh
git clone <this repo> ~/issue-channel && cd ~/issue-channel
export ISSUECHAN_DIR=$PWD          # put this in your shell profile; PROMPTS.md and spawn use it
npm ci && node --test
```

Then: [deploy the server](#deploy) (pick a tunnel), [add the webhook](#deploy) to each repo you want to talk through, and [connect Claude Code](#use-from-claude-code).

For Codex or ChatGPT.app, use the [Codex adapter setup](adapters/codex/README.md), including the opt-in macOS launcher for local ChatGPT builds that start their own stdio app-server. The MCP tools loading does not by itself verify incoming delivery.

## Deploy

GitHub must reach the server's `/webhook/github`. `deploy/issue-channel.sh` runs the server and a `cloudflared` tunnel as two containers (plain `sudo docker`; set `DOCKER=docker` if your user can run docker). Pick one tunnel:

| | Quick tunnel | Named (login) tunnel |
|---|---|---|
| Needs | nothing: no Cloudflare account, no login | a Cloudflare account and a domain (zone) on it |
| URL | random `https://<words>.trycloudflare.com`, **new on every container start** | your own stable hostname, e.g. `issue-channel.example.com` |
| After a restart or reboot | run `webhook-add` again (it repoints the existing webhook) | nothing |
| Good for | trying it out, a laptop | a server that stays up |

### Option A: quick tunnel

```sh
deploy/issue-channel.sh init --quick
deploy/issue-channel.sh build
deploy/issue-channel.sh up                           # prints the trycloudflare URL
deploy/issue-channel.sh status                       # local + public /healthz
deploy/issue-channel.sh webhook-add <owner/repo>     # GitHub webhook: issues + issue_comment
```

Cloudflare offers quick tunnels for testing, without an uptime guarantee. The containers restart on their own after a reboot, but the tunnel then gets a new URL: run `deploy/issue-channel.sh webhook-add <owner/repo>` again for each repo (`deploy/issue-channel.sh url` prints the current one). Deliveries sent to the old URL fail; GitHub lists them under the webhook's *Recent Deliveries*, where they can be redelivered.

### Option B: named tunnel (Cloudflare login)

```sh
# one-time: Cloudflare login + tunnel (cloudflared runs from its container image)
cf() { sudo docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/work -v "$HOME/.cloudflared:/work/.cloudflared" cloudflare/cloudflared:latest "$@"; }
cf tunnel login                                      # open the URL, pick your zone, Authorize
cf tunnel create issue-channel
cf tunnel route dns issue-channel <hostname>         # e.g. issue-channel.example.com

deploy/issue-channel.sh init <hostname>              # secrets + tunnel config in ~/.local/share/issue-channel
deploy/issue-channel.sh build
deploy/issue-channel.sh up
deploy/issue-channel.sh status                       # local + public /healthz
deploy/issue-channel.sh webhook-add <owner/repo>     # GitHub webhook: issues + issue_comment
```

The containers use `--restart unless-stopped`, so they come back after a reboot. The DB is at `~/.local/share/issue-channel/events.db`. `.env` in the same directory holds `WEBHOOK_SECRET` and `API_KEY` (mode 0600, never commit it). Only comments by the repo owner are delivered unless you set `ISSUECHAN_ALLOWED_AUTHORS` (below).

### Peers: join from another box

Your agents can run on several machines (say a server and a laptop) behind one GitHub webhook. Every box runs its own server, and the box with the webhook (the *primary*, ideally on a named tunnel so its URL stays put) copies each webhook it receives to the other boxes as the **same HTTP request**: same body, same `X-Hub-Signature-256`. Each box checks the signature itself and serves its own sessions from its own DB, so a box keeps working while another is offline.

```sh
# on the new box: use the primary's secrets (WEBHOOK_SECRET signs the copies, API_KEY guards /api/peers)
mkdir -p ~/.local/share/issue-channel && chmod 700 ~/.local/share/issue-channel
scp primary:.local/share/issue-channel/.env ~/.local/share/issue-channel/.env
deploy/issue-channel.sh init --quick
deploy/issue-channel.sh build
deploy/issue-channel.sh up
deploy/issue-channel.sh join https://<primary-hostname> laptop    # name defaults to the short hostname
deploy/issue-channel.sh peers                                     # on either box: peers + last forward status
```

- Peers live in the server's SQLite and are read on every webhook, so `join`, `leave` and `PUT/DELETE /api/peers` take effect at once on the running servers: no restart on either side.
- `join` registers this box's URL on the primary, adds the primary as a peer here, and saves both in `deploy.env`. A quick tunnel gets a new URL on every start, so `up` (and `restart`) re-join with the new URL by themselves. `leave` undoes the join.
- Pushing works both ways: a webhook that a joined box receives directly (say, a repo whose webhook points at the laptop's quick tunnel) goes to the primary, and the primary relays it to the other boxes.
- **No loops:** a server forwards a delivery only the first time it stores it; a copy that comes back is a duplicate (`200`) and stops there. Copies carry a hop count (`X-Issue-Channel-Hop`), and nothing is relayed beyond 4 hops.
- **Auth:** a copy keeps GitHub's `X-Hub-Signature-256` and adds `X-Issue-Channel-Signature`, an HMAC with the same `WEBHOOK_SECRET` over the delivery id, event, hop count and body. A receiver needs both, so a replayed GitHub request can't fake a copy, a hop count or a delivery id. `/api/peers` and the subscription lookups between boxes need `API_KEY`.
- **Bad connectivity:** copies go through a durable outbox in SQLite, one sender per peer, in order. When a peer fails, the wait between tries doubles: 2 s, 4 s, 8 s, … up to 10 min, ±20 % jitter. Backoff is per peer, so a down peer costs one request per try, not one per queued copy. After 12 failures in a row (about 37 min) the peer is **parked**: no more timed tries, but its copies stay queued (up to 7 days or 10 000 per peer, the oldest are dropped first). A parked peer is tried again when it re-joins (`up` does that after a restart), once per new webhook, and at server start. The first answer drains its whole backlog. A 4xx answer (for example a box with another secret) drops that copy only. Copies also survive a server restart. Tune it with `PEER_RETRY_BASE_MS`, `PEER_RETRY_MAX_MS`, `PEER_RETRY_MAX_ATTEMPTS`, `PEER_OUTBOX_MAX_AGE_H` and `PEER_OUTBOX_MAX_ROWS` in `.env`. `deploy/issue-channel.sh peers` shows each peer's queue, failures and next try.
- `/bot <name>` works across boxes: `GET /api/subscriptions` adds the peers' sessions (and their peers', 2 hops, 3 s timeout each, peers that are down are skipped), so a session listening on the laptop counts as a target on the primary too.
- Without a server on the new box at all: set `ISSUECHAN_URL` to the primary's public URL (and `ISSUECHAN_API_KEY`). That's simpler, but the box then depends on the primary being up.

### Linear issues

A Linear issue works like a GitHub issue: comment `/bot …` on it, and the agent receives it and replies **in that comment's thread**. By default the agent **acts as you**, the way it uses your `gh` login on GitHub: its replies, 👀 and ✅ show as you.

| | GitHub | Linear |
|---|---|---|
| Ref in the tools | `repo: "owner/name"`, `issue: 12` | `repo: "linear:ENG"`, `issue: 123` (= ENG-123) |
| Webhook | `/webhook/github`, `X-Hub-Signature-256`, `WEBHOOK_SECRET` | `/webhook/linear`, `Linear-Signature` (hex HMAC of the body) + `webhookTimestamp` within 60 s, `LINEAR_WEBHOOK_SECRET` |
| Reply | new top-level comment, `<details>` toggle, bot marker `<!-- issue-channel:bot -->` | reply in the `/bot` comment's thread (`commentCreate` with `parentId` = thread root), Linear's collapsible section (`+++`), marker `[//]: # (issue-channel:bot)` (kept in the markdown, not rendered; Linear would show an HTML comment as text) |
| 👀 / done | reactions `eyes` → `rocket` | reactions `eyes` → `white_check_mark`; or resolve the thread (`ISSUECHAN_LINEAR_DONE=resolve` or `both`) |
| Who counts | the repo owner (or `ISSUECHAN_ALLOWED_AUTHORS`) | emails in `LINEAR_ALLOWED_AUTHORS` (in `linear.env`) or `ISSUECHAN_LINEAR_ALLOWED` |
| Self-filter | the bot marker | the marker; when acting as an app, also comments by the app user (`<uuid>@oauthapp.linear.app`) |

**Acting as you vs. as an app.** As you (default): replies look like yours, you can grant `admin` (so the agent can create webhooks and delete comments through the API), but Linear doesn't notify you about the agent's replies, since they are your own comments. As an OAuth app (`actor=app`): replies show as the app and notify you like any other commenter, but Linear refuses `admin` for app users, so webhooks go in the app's settings and other users' comments can't be deleted.

Setup:
1. **Log in:** create an OAuth application in Linear (Settings → API → OAuth applications), then run `deploy/issue-channel.sh linear-login`. It serves a login page behind a throwaway quick tunnel at a secret path and prints the **callback URL** to add to the app and the page to open. Linear has no device-code flow, so this is the equivalent. Approve, and the tokens land in `~/.local/share/issue-channel/linear.env` (0600); the page and tunnel stop. Access tokens last 24 h; the channel refreshes them and writes the new pair back. Tick "act as the app" on the page for the app actor. Instead of OAuth, a personal API key works too: `LINEAR_API_KEY=lin_api_…` in `linear.env`.
2. **Allowlist:** `LINEAR_ALLOWED_AUTHORS=you@example.com` (comma-separated) in `linear.env`.
3. **Webhook** (events `Comment` and `Issue`, URL `https://<hostname>/webhook/linear`): acting as you with `admin`, `deploy/issue-channel.sh linear-webhook ENG` creates it for team `ENG`, stores a fresh `LINEAR_WEBHOOK_SECRET` in `.env` and restarts the server. Or enable **Webhooks** in the OAuth app's settings and paste its signing secret on the login page (saved as `LINEAR_WEBHOOK_SECRET`; `linear-login` restarts the server).
4. Ask the agent: *"listen to Linear issue ENG-123"* (it calls `issue_subscribe` with `repo: "linear:ENG", issue: 123`).

Peers replicate Linear deliveries too (to `/webhook/linear` with Linear's headers; `LINEAR_WEBHOOK_SECRET` must be the same on every box, like the rest of `.env`).

#### Local Linear OAuth without Docker or a tunnel

When the browser and channel run on the same computer, use the loopback PKCE helper:

```sh
node deploy/linear-login-local.mjs
```

It prints a local login page and the **exact callback URL** to add to your private Linear OAuth app. Add that callback, then open the login page on the same computer and authorize. The helper binds only to `127.0.0.1`, stores credentials in the usual `linear.env` with mode 0600, and stops shortly after a successful login (or after 30 minutes). Press Ctrl-C to cancel. A new run generates a new secret callback path; update the app's callback URL accordingly. Set `PORT` if 8795 is occupied.

It requests the same scopes as the tunneled login: acting as you, `read,write,comments:create,admin` (`admin` lets the agent create webhooks and delete comments); as the app, without `admin`, which Linear refuses for app users. For fewer scopes, set them explicitly, for example `LINEAR_LOGIN_SCOPES=read,write,comments:create node deploy/linear-login-local.mjs` (also honored by the tunneled login).

This replaces the **login tunnel**, not the event transport: configure the author allowlist and a reachable signed webhook as described above. A blocked Cloudflare connection will still prevent webhook delivery even when local OAuth succeeds; use another reachable webhook host. Finish setup with a new `/bot` and a reply visible in its Linear thread.

## Use from Claude Code

```sh
npm ci   # in the issue-channel checkout (skip if done in the quick start)
claude mcp add -s user issuechan -- node "$PWD/adapters/claude-code/channel.mjs"
```

An older config that runs `…/channel/channel.mjs` keeps working through the shim.

Then add [`adapters/claude-code/CLAUDE.snippet.md`](adapters/claude-code/CLAUDE.snippet.md) to `~/.claude/CLAUDE.md`. It is **required**: Claude Code labels channel messages that arrive mid-turn as external input, and without this note Claude declines to act on them. The note is safe because only signed webhooks from allowlisted authors get through.

Start a session with the channel loaded. Custom channels need the development flag during the research preview, and it only works in interactive sessions:

```sh
claude --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan
```

If you start Claude Code through a wrapper, set `ISSUECHAN_LAUNCHER` to it so `spawn/spawn-agent.sh` uses it too (default `claude`).

Then say: *"create a new issue in <owner/repo> and listen to it"*. The repo needs the webhook (`webhook-add`). Ready-made prompts are in [`PROMPTS.md`](PROMPTS.md).

| Env (channel) | Default |
|---|---|
| `ISSUECHAN_URL` | `http://127.0.0.1:8787` (use your public URL from another machine) |
| `ISSUECHAN_API_KEY` | `API_KEY` from `ISSUECHAN_ENV_FILE` (`~/.local/share/issue-channel/.env`) |
| `ISSUECHAN_SESSION` | `default`; also settable via `issue_subscribe({session})` |
| `ISSUECHAN_ALLOWED_AUTHORS` | the repo owner |
| `ISSUECHAN_REACTION` | `eyes`: the channel adds 👀 to each delivered `/bot` comment through the local `gh` login; set it to empty to disable |
| `ISSUECHAN_DONE_REACTION` | `rocket`: replaces 👀 when the job is done (GitHub has no ✅ reaction); set it to empty to disable |
| `ISSUECHAN_RESUME_DELAY_MS` | `3000`: after `--resume` or `/mcp` reconnect, how long auto-resume waits after the MCP `initialized` handshake before delivering, because Claude Code drops channel notifications that arrive before it registers its listener |

### Agent skill

[`skills/issue-channel/`](skills/issue-channel/SKILL.md) teaches an agent to work through issuechan reliably, on GitHub and Linear issues. It's the same `SKILL.md` format for Claude Code and Codex:

| Part | What |
|---|---|
| `SKILL.md` | Refs, what to do with every delivery (answer where it came from; `done` and `comment_ids`, so finishing one request doesn't close another), listening (a new subscription starts from "now", so check for an unanswered `/bot`; one home issue per agent; `/bot <word>` targeting), writing (open items as a table, markers, attachments), and backing up before changing or deleting |
| `reference/` | `consolidate.md` (the consolidation procedure, GitHub and Linear), `linear.md` (verified Linear behavior: threads, marker, admin, cascading deletes, webhooks), `ops.md` (which code runs, finding the channel process, reloading the channel or the session with herdr) |
| `scripts/` | `backup-issue.mjs <ref>` (issue + all comments to `~/.local/state/issue-channel/backups/`), `linear.mjs` (`issue`, `comment`, `delete-comment`, `set-description`, `set-state`, `whoami`), `attachment.sh <url> <out>` (GitHub and Linear attachments with the right token) |

Install it by linking it into the harness's skills directory (new sessions pick it up):

```sh
mkdir -p ~/.claude/skills && ln -sfn "$ISSUECHAN_DIR/skills/issue-channel" ~/.claude/skills/issue-channel   # Claude Code
mkdir -p ~/.codex/skills  && ln -sfn "$ISSUECHAN_DIR/skills/issue-channel" ~/.codex/skills/issue-channel    # Codex
```

[`skills/live-context/`](skills/live-context/SKILL.md) lets an agent compact its own context the way pi-clm does: `ctx open` writes the working context to a file (one block per request, reply, tool call, tool output; reasoning only as a keep-or-delete placeholder), the agent edits it with pi-clm's rules (surgical, keep conversational units, never print the whole file), and `ctx apply` checks the edit and switches to it when the turn ends. Under the hood that is `session-fork` + `spawn/restart-agent.sh --fork` (Claude Code in herdr only). The skill is worded neutrally on purpose: the agent works on "its working context" through the tool and never reads raw session logs itself; an earlier design that had it mirror its own Claude Code log was stopped by the model's safeguards three times. Install for Claude Code: `ln -sfn "$ISSUECHAN_DIR/skills/live-context" ~/.claude/skills/live-context`.

### `/bot` rules

- A **newly created** comment whose text starts with `/bot` triggers a delivery: the buffered new/edited comments (and issue-body edits) since the last delivery, in order. Edits never trigger, including edits of a `/bot` comment. They wait in the buffer for the next `/bot`.
- An edit of a comment the agent has already seen is delivered with a diff against the version the agent saw, plus the full new text. An edit that restores exactly what the agent saw is dropped. Deleting a comment the agent has already seen is reported. Deleting one it hasn't seen just drops it.
- `/bot <name>` (a single token on the first line) targets a named session. If `<name>` is not an active session on that issue, the comment counts as untargeted (for example `/bot hi`).
- Idle session: Claude starts a new turn. Busy session: the message lands after the current tool call, inside the same turn. Text Claude is already streaming is not interrupted.
- Request lifecycle: 👀 when a `/bot` is delivered, 🚀 when the agent marks it done (`issue_reply` with `done` defaulting to true, or `issue_done`). Open requests are saved with the subscription. A deleted comment, or a 👀 that's already gone, is tolerated.
- Subscriptions are saved per agent session (Claude Code: `CLAUDE_CODE_SESSION_ID`, in `~/.local/state/issue-channel/`). They are restored automatically after `/mcp` reconnect or `claude --resume`/`--continue`, from the last delivered trigger, so comments made while the channel was down are not lost. A new session starts with no subscriptions.

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
| `GET/PUT/DELETE /api/subscriptions` | session registry used for `/bot <name>`; `GET` also returns the peers' sessions (marked `peer: true`; `depth=0` for this server only) |
| `GET/PUT/DELETE /api/peers` | `{name, url}`: servers this one copies each new webhook to; `GET` adds `pending`, `fail_count`, `parked`, `next_at` and the last status. `PUT` (re-join) resets the backoff and sends the backlog |

Filter keys: `repo`, `issue`, `event`/`action`/`author` (a string or a list), `title`/`body` as `{contains|like|regex: "..."}`, and `exclude_body_contains`.

```sh
curl -s -H "Authorization: Bearer $API_KEY" "$(deploy/issue-channel.sh url)/api/events/query" \
  -d '{"since":0,"timeout":60,"filter":{"repo":"owner/repo","issue":10,"body":{"regex":"^/bot"}}}'
```

## Test

```sh
npm ci && node --test   # in the issue-channel checkout: server (incl. peers), core, adapters, session-fork
```
