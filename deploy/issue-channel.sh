#!/usr/bin/env bash
# Deploy issue-channel (server + Cloudflare tunnel) with plain docker, no compose.
#
#   issue-channel.sh init <hostname> [tunnel-name]   create state dir, secrets, tunnel config
#   issue-channel.sh build                            build the server image
#   issue-channel.sh up | down | restart | status | logs [server|tunnel]
#   issue-channel.sh webhook-add <owner/repo>         register the GitHub webhook (gh CLI)
#
# State lives in $ISSUECHAN_STATE (default ~/.local/share/issue-channel):
#   .env            WEBHOOK_SECRET, API_KEY (0600, never commit)
#   deploy.env      HOSTNAME, TUNNEL_NAME, TUNNEL_ID
#   cloudflared.yml tunnel ingress config
#   events.db       SQLite event log
# The tunnel must already exist (`cloudflared tunnel create` + `tunnel route dns`);
# its credentials JSON is read from ~/.cloudflared/<TUNNEL_ID>.json.
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
}

cmd_init() {
  local host="${1:-}" name="${2:-issue-channel}"
  [[ -n "$host" ]] || die "usage: $0 init <hostname> [tunnel-name]"
  mkdir -p "$STATE"; chmod 700 "$STATE"
  if [[ ! -f "$STATE/.env" ]]; then
    umask 077
    printf 'WEBHOOK_SECRET=%s\nAPI_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$STATE/.env"
    echo "generated secrets in $STATE/.env"
  fi
  local id
  id="$(cf tunnel list --name "$name" --output json | jq -r '.[0].id // empty')"
  [[ -n "$id" ]] || die "tunnel '$name' not found; create it with: cloudflared tunnel create $name && cloudflared tunnel route dns $name $host"
  [[ -f "$CF_DIR/$id.json" ]] || die "missing tunnel credentials $CF_DIR/$id.json"
  printf 'HOSTNAME=%s\nTUNNEL_NAME=%s\nTUNNEL_ID=%s\n' "$host" "$name" "$id" > "$STATE/deploy.env"
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
  d run -d --name "$TUNNEL" --network "$NET" --restart unless-stopped --user "$UIDGID" \
    -v "$STATE/cloudflared.yml:/etc/cloudflared/config.yml:ro" \
    -v "$CF_DIR/$TUNNEL_ID.json:/etc/cloudflared/creds.json:ro" \
    "$CF_IMAGE" tunnel --config /etc/cloudflared/config.yml run >/dev/null
  echo "up: local http://127.0.0.1:8787, public https://$HOSTNAME"
}

cmd_down() { d rm -f "$SERVER" "$TUNNEL" >/dev/null 2>&1 || true; echo down; }

cmd_status() {
  load
  d ps -a --filter "name=issue-channel-" --format 'table {{.Names}}\t{{.Status}}'
  printf 'local  /healthz: '; curl -fsS http://127.0.0.1:8787/healthz || echo FAIL; echo
  printf 'public /healthz: '; curl -fsS "https://$HOSTNAME/healthz" || echo FAIL; echo
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
  local url="https://$HOSTNAME/webhook/github" secret
  secret="$(sed -n 's/^WEBHOOK_SECRET=//p' "$STATE/.env")"
  if gh api "repos/$repo/hooks" --jq ".[] | select(.config.url == \"$url\") | .id" | grep -q .; then
    echo "webhook for $url already exists on $repo"; return
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
  logs) shift; cmd_logs "$@" ;;
  webhook-add) shift; cmd_webhook_add "$@" ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
