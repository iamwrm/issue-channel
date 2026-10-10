#!/usr/bin/env bash
# Deploy issue-channel (server + Cloudflare tunnel) with plain docker, no compose.
#
#   issue-channel.sh init <hostname> [tunnel-name]   named tunnel: create state dir, secrets, tunnel config
#   issue-channel.sh init --quick                     quick tunnel: no Cloudflare account, random *.trycloudflare.com URL
#   issue-channel.sh build                            build the server image
#   issue-channel.sh up | down | restart | status | logs [server|tunnel]
#   issue-channel.sh url                              print the public URL
#   issue-channel.sh webhook-add <owner/repo>         register the GitHub webhook (gh CLI); in quick mode
#                                                     it also repoints an existing quick-tunnel webhook
#   issue-channel.sh join <primary-url> [name]        replicate the primary's webhooks to this box (needs the
#                                                     primary's .env here); `up` re-joins with the new URL
#   issue-channel.sh leave | peers                    stop replicating / list this server's peers
#   issue-channel.sh linear-login                     Linear OAuth login page behind a temporary quick tunnel; the
#                                                     agent acts as you (tick "act as the app" to change that)
#   issue-channel.sh linear-webhook <TEAM>            create a Linear webhook for team key <TEAM> (needs an admin
#                                                     token in linear.env); stores LINEAR_WEBHOOK_SECRET, restarts
#
# State lives in $ISSUECHAN_STATE (default ~/.local/share/issue-channel):
#   .env            WEBHOOK_SECRET, API_KEY (0600, never commit)
#   deploy.env      MODE (named|quick); named: HOSTNAME, TUNNEL_NAME, TUNNEL_ID; joined: PRIMARY_URL, PEER_NAME
#   cloudflared.yml tunnel ingress config (named mode)
#   events.db       SQLite event log
# A named tunnel must already exist (`cloudflared tunnel create` + `tunnel route dns`);
# its credentials JSON is read from ~/.cloudflared/<TUNNEL_ID>.json.
# A quick tunnel gets a new URL every time its container starts: run webhook-add again after up/restart.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
STATE="${ISSUECHAN_STATE:-$HOME/.local/share/issue-channel}"
CF_DIR="${CLOUDFLARED_DIR:-$HOME/.cloudflared}"
DOCKER="${DOCKER:-sudo docker}"
IMAGE=issue-channel:local
CF_IMAGE=cloudflare/cloudflared:latest
NET=issue-channel-net
SERVER=issue-channel-server
TUNNEL=issue-channel-tunnel
UIDGID="$(id -u):$(id -g)"

die() { echo "error: $*" >&2; exit 1; }
d() { $DOCKER "$@"; }
cf() { d run --rm --user "$UIDGID" -e HOME=/work -v "$CF_DIR:/work/.cloudflared" "$CF_IMAGE" "$@"; }
load() {
  [[ -f "$STATE/deploy.env" ]] || die "run: $0 init <hostname>"
  # shellcheck disable=SC1091
  source "$STATE/deploy.env"
  MODE="${MODE:-named}"
}

# Public base URL. A quick tunnel logs its random URL once it is connected.
public_url() {
  if [[ $MODE == named ]]; then echo "https://$HOSTNAME"; return; fi
  local url='' i
  for i in $(seq 1 30); do
    url="$(d logs "$TUNNEL" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)" && [[ -n $url ]] && break
    sleep 1
  done
  [[ -n $url ]] || die "quick tunnel URL not found; see: $0 logs tunnel"
  echo "$url"
}

init_state() {
  mkdir -p "$STATE"; chmod 700 "$STATE"
  if [[ ! -f "$STATE/.env" ]]; then
    (umask 077; printf 'WEBHOOK_SECRET=%s\nAPI_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$STATE/.env")
    echo "generated secrets in $STATE/.env"
  fi
}

cmd_init() {
  local host="${1:-}" name="${2:-issue-channel}"
  if [[ "$host" == --quick ]]; then
    init_state
    printf 'MODE=quick\n' > "$STATE/deploy.env"
    echo "configured a quick tunnel (URL assigned on up)"; return
  fi
  [[ -n "$host" ]] || die "usage: $0 init <hostname> [tunnel-name] | init --quick"
  init_state
  local id
  id="$(cf tunnel list --name "$name" --output json | jq -r '.[0].id // empty')"
  [[ -n "$id" ]] || die "tunnel '$name' not found; create it with: cloudflared tunnel create $name && cloudflared tunnel route dns $name $host"
  [[ -f "$CF_DIR/$id.json" ]] || die "missing tunnel credentials $CF_DIR/$id.json"
  printf 'MODE=named\nHOSTNAME=%s\nTUNNEL_NAME=%s\nTUNNEL_ID=%s\n' "$host" "$name" "$id" > "$STATE/deploy.env"
  cat > "$STATE/cloudflared.yml" <<EOF
tunnel: $id
credentials-file: /etc/cloudflared/creds.json
no-autoupdate: true
ingress:
  - hostname: $host
    service: http://$SERVER:8787
  - service: http_status:404
EOF
  echo "configured $host -> tunnel $name ($id)"
}

cmd_build() { d build -t "$IMAGE" "$ROOT/server"; }

cmd_up() {
  load
  d network inspect "$NET" >/dev/null 2>&1 || d network create "$NET" >/dev/null
  d rm -f "$SERVER" "$TUNNEL" >/dev/null 2>&1 || true
  d run -d --name "$SERVER" --network "$NET" --restart unless-stopped \
    --user "$UIDGID" --env-file "$STATE/.env" -v "$STATE:/data" \
    -p 127.0.0.1:8787:8787 "$IMAGE" >/dev/null
  if [[ $MODE == quick ]]; then
    d run -d --name "$TUNNEL" --network "$NET" --restart unless-stopped --user "$UIDGID" \
      "$CF_IMAGE" tunnel --no-autoupdate --url "http://$SERVER:8787" >/dev/null
  else
    d run -d --name "$TUNNEL" --network "$NET" --restart unless-stopped --user "$UIDGID" \
      -v "$STATE/cloudflared.yml:/etc/cloudflared/config.yml:ro" \
      -v "$CF_DIR/$TUNNEL_ID.json:/etc/cloudflared/creds.json:ro" \
      "$CF_IMAGE" tunnel --config /etc/cloudflared/config.yml run >/dev/null
  fi
  echo "up: local http://127.0.0.1:8787, public $(public_url)"
  if [[ -n ${PRIMARY_URL:-} ]]; then
    wait_healthy && cmd_join "$PRIMARY_URL" "$PEER_NAME"
  elif [[ $MODE == quick ]]; then
    echo "quick tunnel: the URL is new, run: $0 webhook-add <owner/repo>"
  fi
  return 0
}

api_key() { sed -n 's/^API_KEY=//p' "$STATE/.env"; }
# api <base-url> <method> <path> [json]: call an issue-channel API with this box's key.
api() {
  local args=(-fsS -X "$2" -H "Authorization: Bearer $(api_key)" -H 'content-type: application/json' --max-time 15)
  [[ -n ${4:-} ]] && args+=(-d "$4")
  curl "${args[@]}" "${1%/}$3"
}
wait_healthy() {
  local i
  for i in $(seq 1 30); do curl -fsS --max-time 2 "$(public_url)/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "warning: $(public_url) is not reachable yet" >&2; return 0
}

# Join a primary: it replicates every webhook it receives to this box, and this box to it. Both boxes must
# share one .env (WEBHOOK_SECRET signs the copies, API_KEY guards /api/peers), so copy the primary's first.
cmd_join() {
  load
  local primary="${1:-}" name="${2:-$(hostname -s)}" me
  [[ -n "$primary" ]] || die "usage: $0 join <primary-url> [name]"
  primary="${primary%/}"
  api "$primary" GET /api/cursor >/dev/null 2>&1 ||
    die "cannot use $primary/api with this box's API_KEY: copy the primary's $STATE/.env here, then $0 restart"
  me="$(public_url)"
  api "$primary" PUT /api/peers "$(jq -nc --arg name "$name" --arg url "$me" '{name: $name, url: $url}')" >/dev/null
  api http://127.0.0.1:8787 PUT /api/peers "$(jq -nc --arg url "$primary" '{name: "primary", url: $url}')" >/dev/null
  sed -i '/^PRIMARY_URL=/d; /^PEER_NAME=/d' "$STATE/deploy.env"
  printf 'PRIMARY_URL=%s\nPEER_NAME=%s\n' "$primary" "$name" >> "$STATE/deploy.env"
  echo "joined $primary as $name ($me)"
}

cmd_leave() {
  load
  [[ -n ${PRIMARY_URL:-} ]] || die "not joined"
  api "$PRIMARY_URL" DELETE /api/peers "$(jq -nc --arg name "$PEER_NAME" '{name: $name}')" >/dev/null || echo "warning: could not reach $PRIMARY_URL" >&2
  api http://127.0.0.1:8787 DELETE /api/peers '{"name":"primary"}' >/dev/null || true
  sed -i '/^PRIMARY_URL=/d; /^PEER_NAME=/d' "$STATE/deploy.env"
  echo "left $PRIMARY_URL"
}

cmd_peers() {
  load
  api http://127.0.0.1:8787 GET /api/peers |
    jq -r '["NAME", "URL", "PENDING", "FAILS", "STATE", "LAST", "AT"],
      (.peers[] | [.name, .url, .pending, .fail_count, (if .parked then "parked" elif .next_at then "retry " + .next_at else "ok" end),
        (.last_status // "-"), (.last_at // "-")]) | @tsv' | column -t -s $'\t'
}

# Linear: serve deploy/linear-login.mjs behind a throwaway quick tunnel at a secret path until one login succeeds.
cmd_linear_login() {
  load
  local port="${LINEAR_LOGIN_PORT:-8795}" name=issue-channel-linear-login secret done url i pid
  command -v node >/dev/null || die "node not found (Node 24 is needed for the login page)"
  secret="$(openssl rand -hex 16)"; done="$(mktemp -u)"
  d rm -f "$name" >/dev/null 2>&1 || true
  d run -d --name "$name" --network host --user "$UIDGID" "$CF_IMAGE" tunnel --no-autoupdate --url "http://127.0.0.1:$port" >/dev/null
  for i in $(seq 1 30); do url="$(d logs "$name" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)"; [[ -n $url ]] && break; sleep 1; done
  [[ -n $url ]] || { d rm -f "$name" >/dev/null; die "quick tunnel did not start"; }
  ISSUECHAN_STATE="$STATE" LOGIN_SECRET="$secret" PUBLIC_URL="$url" PORT="$port" DONE_FILE="$done" node "$HERE/linear-login.mjs" 2>/dev/null &
  pid=$!
  trap 'kill $pid 2>/dev/null; d rm -f '"$name"' >/dev/null 2>&1; rm -f "'"$done"'"' EXIT
  for i in $(seq 1 40); do curl -fsS --max-time 3 -o /dev/null "$url/$secret/" 2>/dev/null && break; sleep 3; done
  echo "callback URL (add it to the OAuth app): $url/$secret/callback"
  echo "login page:                             $url/$secret/"
  echo "waiting for the login (30 min max) ..."
  for i in $(seq 1 360); do [[ -f $done ]] && break; sleep 5; done
  [[ -f $done ]] || die "no login within 30 min"
  echo "logged in (acting as: $(cut -d' ' -f1 "$done")); token stored in $STATE/linear.env"
  if grep -q webhook-secret "$done"; then echo "LINEAR_WEBHOOK_SECRET saved; restarting the server to load it"; cmd_down >/dev/null; cmd_up; fi
}

# Linear: create (or reuse) a webhook pointing at /webhook/linear for one team, with a fresh signing secret.
cmd_linear_webhook() {
  load
  local team="${1:-}" lenv="${ISSUECHAN_LINEAR_ENV_FILE:-$STATE/linear.env}" token url secret tid q
  [[ -n "$team" ]] || die "usage: $0 linear-webhook <TEAM key, e.g. ENG>"
  token="$(sed -n 's/^LINEAR_ACCESS_TOKEN=//p' "$lenv")"; [[ -n $token ]] && token="Bearer $token" || token="$(sed -n 's/^LINEAR_API_KEY=//p' "$lenv")"
  [[ -n $token ]] || die "no Linear token in $lenv (log in first, see README: Linear)"
  lgql() { curl -fsS https://api.linear.app/graphql -H "authorization: $token" -H 'content-type: application/json' -d "$1"; }
  tid="$(lgql "$(jq -nc --arg k "$team" '{query: "query($k: String!) { teams(filter: {key: {eq: $k}}) { nodes { id name } } }", variables: {k: $k}}')" | jq -r '.data.teams.nodes[0].id // empty')"
  [[ -n $tid ]] || die "Linear team $team not found"
  url="$(public_url)/webhook/linear"
  secret="$(sed -n 's/^LINEAR_WEBHOOK_SECRET=//p' "$STATE/.env")"
  [[ -n $secret ]] || { secret="$(openssl rand -hex 32)"; printf 'LINEAR_WEBHOOK_SECRET=%s\n' "$secret" >> "$STATE/.env"; }
  q='mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id url enabled } } }'
  lgql "$(jq -nc --arg q "$q" --arg url "$url" --arg tid "$tid" --arg s "$secret" \
    '{query: $q, variables: {input: {url: $url, teamId: $tid, resourceTypes: ["Comment", "Issue"], secret: $s, label: "issue-channel"}}}')" |
    jq -e '.data.webhookCreate.success' >/dev/null || die "webhookCreate failed (admin scope needed)"
  echo "Linear webhook for team $team -> $url; restarting the server to load LINEAR_WEBHOOK_SECRET"
  cmd_down >/dev/null; cmd_up
}

cmd_down() { d rm -f "$SERVER" "$TUNNEL" >/dev/null 2>&1 || true; echo down; }

cmd_status() {
  load
  d ps -a --filter "name=issue-channel-" --format 'table {{.Names}}\t{{.Status}}'
  printf 'local  /healthz: '; curl -fsS http://127.0.0.1:8787/healthz || echo FAIL; echo
  printf 'public /healthz: '; curl -fsS "$(public_url)/healthz" || echo FAIL; echo
}

cmd_logs() {
  case "${1:-server}" in
    server) d logs --tail 100 "$SERVER" ;;
    tunnel) d logs --tail 100 "$TUNNEL" ;;
    *) die "logs [server|tunnel]" ;;
  esac
}

cmd_webhook_add() {
  load
  local repo="${1:-}"; [[ -n "$repo" ]] || die "usage: $0 webhook-add <owner/repo>"
  local url secret old
  url="$(public_url)/webhook/github"
  secret="$(sed -n 's/^WEBHOOK_SECRET=//p' "$STATE/.env")"
  if gh api "repos/$repo/hooks" --jq ".[] | select(.config.url == \"$url\") | .id" | grep -q .; then
    echo "webhook for $url already exists on $repo"; return
  fi
  if [[ $MODE == quick ]]; then
    old="$(gh api "repos/$repo/hooks" --jq '.[] | select(.config.url | test("^https://[a-z0-9-]+\\.trycloudflare\\.com/webhook/github$")) | .id' | head -1)"
    if [[ -n $old ]]; then
      jq -n --arg url "$url" --arg secret "$secret" '{config: {url: $url, content_type: "json", secret: $secret, insecure_ssl: "0"}}' \
        | gh api -X PATCH "repos/$repo/hooks/$old" --input - --jq '"repointed webhook \(.id) on '"$repo"' -> \(.config.url)"'
      return
    fi
  fi
  jq -n --arg url "$url" --arg secret "$secret" \
    '{name: "web", active: true, events: ["issues", "issue_comment"], config: {url: $url, content_type: "json", secret: $secret, insecure_ssl: "0"}}' \
    | gh api -X POST "repos/$repo/hooks" --input - --jq '"created webhook \(.id) on '"$repo"' -> \(.config.url)"'
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  build) cmd_build ;;
  up) cmd_up ;;
  down) cmd_down ;;
  restart) cmd_down; cmd_up ;;
  status) cmd_status ;;
  url) load; public_url ;;
  join) shift; cmd_join "$@" ;;
  leave) cmd_leave ;;
  peers) cmd_peers ;;
  linear-login) cmd_linear_login ;;
  linear-webhook) shift; cmd_linear_webhook "$@" ;;
  logs) shift; cmd_logs "$@" ;;
  webhook-add) shift; cmd_webhook_add "$@" ;;
  *) sed -n '2,26p' "$0"; exit 1 ;;
esac
