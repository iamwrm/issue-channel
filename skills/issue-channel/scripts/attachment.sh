#!/usr/bin/env bash
# Download an image or file attached to a GitHub or Linear issue, with the right credentials, so you can read it.
#   attachment.sh <url> <out-file>
# GitHub (github.com/user-attachments/..., *.githubusercontent.com): the `gh` login token.
# Linear (uploads.linear.app/...): the token in linear.env (OAuth access token or personal API key).
# Prints "<http code> <content-type> <bytes> <out-file>"; the token is never printed.
set -euo pipefail
url="${1:-}" out="${2:-}"
[[ -n $url && -n $out ]] || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
host="$(sed -E 's#^https?://([^/]+).*#\1#' <<<"$url")"
case "$host" in
  github.com|*.githubusercontent.com)
    auth="token $(gh auth token)" ;;
  uploads.linear.app)
    env="${ISSUECHAN_LINEAR_ENV_FILE:-$HOME/.local/share/issue-channel/linear.env}"
    tok="$(sed -n 's/^LINEAR_ACCESS_TOKEN=//p' "$env")"
    if [[ -n $tok ]]; then auth="Bearer $tok"; else auth="$(sed -n 's/^LINEAR_API_KEY=//p' "$env")"; fi
    [[ -n $auth ]] || { echo "attachment.sh: no Linear token in $env" >&2; exit 1; } ;;
  *) auth="" ;;
esac
args=(-sSL --fail -o "$out" -w '%{http_code} %{content_type}')
[[ -n $auth ]] && args+=(-H "Authorization: $auth")
info="$(curl "${args[@]}" "$url")"
echo "$info $(wc -c <"$out") $out"
