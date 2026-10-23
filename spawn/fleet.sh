#!/usr/bin/env bash
# Snapshot every Claude Code agent that is listening to issues, and bring them all back after a restart of the
# machine or container (tmux and every process gone, $HOME kept).
#
#   fleet.sh snapshot [--out <file>] [--force]
#   fleet.sh recover [<snapshot>] [--dry-run] [--timeout <s>] [--no-verify]
#   fleet.sh status [<snapshot>]
#
# snapshot: finds the live agents from their running issuechan channels (not from the state files, which outlive
#           their agents), and saves for each one its session id, issuechan session name, subscriptions, cwd, tmux
#           window and start command (spawn/launch.sh) to ~/.local/state/issue-channel/snapshots/<UTC>.json and
#           latest.json. Agents without subscriptions are left out. It refuses while an agent is busy (--force
#           saves anyway) or when a transcript can't be resumed.
# recover:  for each saved agent that isn't running, in the saved order: a tmux window with the saved name and cwd
#           (starting a tmux server/session if needed), its start command + `--resume <id>`, the known startup
#           dialogs answered. Its channel then re-subscribes from its own state file and gets every /bot posted
#           in the meantime. Verified quietly: the server lists the agent's session name on every saved issue,
#           registered after the resume. Nothing is posted. A failed agent's window is closed; the others go on.
# status:   which saved agents are running, and which live agents the snapshot doesn't have.
#
# Prints JSON (recover/status: one result per agent). Claude Code in tmux only for now.
set -uo pipefail

HERE=$(dirname "$(readlink -f "$0")")
. "$HERE/launch.sh"

die() { echo "fleet: $*" >&2; exit 1; }
log() { echo "[$(date -u +%T)] $*" >&2; }
usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

STATE_DIR=${ISSUECHAN_STATE_DIR:-$HOME/.local/state/issue-channel}
SNAP_DIR=$STATE_DIR/snapshots
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
ENV_FILE=${ISSUECHAN_ENV_FILE:-$HOME/.local/share/issue-channel/.env}
CHANNEL=${ISSUECHAN_FLEET_CHANNEL:-adapters/claude-code/channel.mjs} # what a channel's command line contains
for bin in jq tmux; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done

cmd=${1:-}; (($#)) && shift
out='' force='' dry='' timeout=90 verify=1 snap=''
while (($#)); do
  case $1 in
    --out) out=$2; shift 2 ;;
    --force) force=1; shift ;;
    --dry-run) dry=1; shift ;;
    --timeout) timeout=$2; shift 2 ;;
    --no-verify) verify=''; shift ;;
    -h|--help) usage ;;
    -*) die "unknown argument: $1 (see --help)" ;;
    *) snap=$1; shift ;;
  esac
done

# Session ids of the running channels, one per line.
live_sessions() {
  local p
  for p in $(pgrep -f "$CHANNEL"); do _launch_env_of "$p" | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p'; done | sort -u
}
env_var() { _launch_env_of "$1" | sed -n "s/^$2=//p" | head -1; }
transcript() { compgen -G "$CLAUDE_DIR/projects/*/$1.jsonl" | head -1; }
# A transcript can be resumed when it exists and its last line is whole JSON.
resumable() { local f; f=$(transcript "$1") && [[ -s $f ]] && tail -n 1 "$f" | jq -e . >/dev/null 2>&1; }

snapshot() {
  local sid agent chan pane state info cwd busy url='' entries='[]' bad=0
  while read -r sid; do
    [[ -n $sid ]] || continue
    state=$STATE_DIR/cc-$sid.json
    [[ -s $state ]] && jq -e '.subs | length > 0' "$state" >/dev/null 2>&1 || { log "skip $sid: no subscriptions"; continue; }
    agent=$(launch_agent_pid "$sid") || { log "skip $sid: no agent process"; continue; }
    chan=$(for p in $(pgrep -f "$CHANNEL"); do _launch_env_of "$p" | grep -qxF "CLAUDE_CODE_SESSION_ID=$sid" && echo "$p"; done | head -1)
    [[ -n $url ]] || url=$(env_var "$chan" ISSUECHAN_URL)
    pane=$(env_var "$agent" TMUX_PANE)
    [[ -n $pane ]] || { log "skip $sid: not in a tmux pane"; bad=1; continue; }
    info=$(tmux display-message -p -t "$pane" '#{session_name}	#{window_index}	#{window_name}	#{@issuechan_agent}') ||
      { log "skip $sid: tmux pane $pane is gone"; bad=1; continue; }
    cwd=$(readlink "/proc/$agent/cwd")
    if ! launch_detect "$sid"; then log "$sid: start command not readable, saving plain claude"; launch_fallback claude; fi
    # The agent running this snapshot is busy with exactly that, so it doesn't count.
    busy=''; [[ $sid != "${CLAUDE_CODE_SESSION_ID:-}" ]] && tmux capture-pane -p -t "$pane" | grep -q 'esc to interrupt' && busy=1
    if [[ -n $busy && -z $force ]]; then log "$sid ($pane) is busy; wait until it's idle, or --force"; bad=1; continue; fi
    resumable "$sid" || { log "$sid: transcript missing or its last line is cut off"; bad=1; continue; }
    entries=$(jq -c --arg sid "$sid" --arg cwd "$cwd" --arg pane "$pane" --arg info "$info" --arg busy "$busy" \
      --arg tr "$(transcript "$sid")" --slurpfile st "$state" \
      --args '. + [{
        name: $st[0].session, session_id: $sid, cwd: $cwd, transcript: $tr, busy: ($busy == "1"),
        tmux: ($info | split("\t") | {session: .[0], window_index: (.[1] | tonumber), window_name: .[2], tag: .[3], pane: $pane}),
        launch: {argv: $ARGS.positional[0] | fromjson, env: $ARGS.positional[1] | fromjson, channels: $ARGS.positional[2]},
        subscriptions: [$st[0].subs[] | {repo, issue, mode: (.mode // "bot")}]
      }]' "$(printf '%s\0' "${LAUNCH_ARGV[@]}" | jq -Rsc 'split("\u0000")[:-1]')" \
      "$(((${#LAUNCH_ENV[@]})) && printf '%s\0' "${LAUNCH_ENV[@]}" | jq -Rsc 'split("\u0000")[:-1]' || echo '[]')" \
      "$LAUNCH_CHANNELS" <<<"$entries")
  done < <(live_sessions)
  ((bad)) && [[ -z $force ]] && die "not saved; fix the above or pass --force"
  local doc file
  doc=$(jq -n --argjson a "$entries" --arg url "$url" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{version: 1, saved_at: $at, server: $url, agents: ($a | sort_by(.tmux.session, .tmux.window_index))}')
  file=${out:-$SNAP_DIR/$(date -u +%Y%m%dT%H%M%SZ).json}
  mkdir -p -m 700 "$(dirname "$file")"
  (umask 077; printf '%s\n' "$doc" >"$file")
  [[ -z $out ]] && (umask 077; cp "$file" "$SNAP_DIR/latest.json")
  chmod 600 "$file"; [[ -n $out ]] || chmod 600 "$SNAP_DIR/latest.json" # a default ACL can widen what umask gives
  log "saved $(jq '.agents | length' <<<"$doc") agent(s) to $file"
  jq -r '.agents[] | "  \(.tmux.session):\(.tmux.window_index) \(.tmux.window_name)  \(.name)  cc:\(.session_id[:8])  \([.subscriptions[] | "\(.repo)#\(.issue)"] | join(" "))  \(.cwd)"' <<<"$doc" >&2
  jq --arg file "$file" '{file: $file, agents: [.agents[] | {name, session_id, issues: [.subscriptions[] | "\(.repo)#\(.issue)"]}]}' <<<"$doc"
}

load() {
  snap=${snap:-$SNAP_DIR/latest.json}
  [[ -s $snap ]] || die "no snapshot at $snap (run: fleet.sh snapshot)"
  jq -e '.version == 1 and (.agents | type == "array")' "$snap" >/dev/null || die "$snap is not a fleet snapshot"
}

# Is the server listing <session> on <repo>#<issue>, registered within the last <s> seconds?
registered() {
  local key url
  url=${ISSUECHAN_URL:-$(jq -r '.server // empty' "$snap")}
  key=${ISSUECHAN_API_KEY:-$(sed -n 's/^API_KEY=//p' "$ENV_FILE" 2>/dev/null | head -1)}
  [[ -n $url ]] || return 2
  curl -fsS --max-time 10 -G "$url/api/subscriptions" -H "authorization: Bearer $key" \
    --data-urlencode "repo=$1" --data-urlencode "issue=$2" --data-urlencode "active_within=$4" --data-urlencode depth=0 |
    jq -e --arg s "$3" '.subscriptions | any(.session == $s)' >/dev/null
}

recover() {
  load
  exec 9>"$STATE_DIR/fleet.lock"; flock -n 9 || die "another fleet recover is running"
  local n i a sid name sess idx wname tag cwd line tab pane started why results='[]' status
  n=$(jq '.agents | length' "$snap")
  for ((i = 0; i < n; i++)); do
    a=$(jq -c ".agents[$i]" "$snap")
    sid=$(jq -r .session_id <<<"$a") name=$(jq -r .name <<<"$a") cwd=$(jq -r .cwd <<<"$a")
    sess=$(jq -r .tmux.session <<<"$a") idx=$(jq -r .tmux.window_index <<<"$a")
    wname=$(jq -r .tmux.window_name <<<"$a") tag=$(jq -r '.tmux.tag // empty' <<<"$a")
    mapfile -t LAUNCH_ARGV < <(jq -r '.launch.argv[]' <<<"$a")
    mapfile -t LAUNCH_ENV < <(jq -r '.launch.env[]' <<<"$a")
    LAUNCH_CHANNELS=$(jq -r .launch.channels <<<"$a")
    line=$(launch_cmd --resume "$sid")
    result() { results=$(jq -c --arg n "$name" --arg s "$sid" --arg st "$1" --arg w "${tab:-}" --arg p "${pane:-}" --arg why "${2:-}" \
      '. + [{name: $n, session_id: $s, status: $st, window: $w, pane: $p} + (if $why != "" then {error: $why} else {} end)]' <<<"$results")
      log "$name (cc:${sid:0:8}): $1${2:+: $2}"; }
    tab='' pane=''
    if launch_agent_pid "$sid" >/dev/null; then result running; continue; fi
    if ! [[ $sid =~ ^[0-9a-f-]{36}$ ]] || ! resumable "$sid"; then result failed "transcript missing or cut off"; continue; fi
    [[ -d $cwd ]] || { result failed "cwd $cwd is gone"; continue; }
    if [[ -n $dry ]]; then log "would open $sess:$idx \"$wname\" in $cwd: $line"; result planned; continue; fi
    # The saved index if it's free, else the next free one; a new tmux session when it doesn't exist yet.
    # 9>&-: a tmux server started here must not inherit the lock and hold it for its lifetime.
    if ! tmux has-session -t "=$sess" 2>/dev/null; then
      read -r tab pane < <(tmux new-session -d -P -F '#{window_id} #{pane_id}' -s "$sess" -n "$wname" -c "$cwd" 9>&-)
    else
      read -r tab pane < <(tmux new-window -d -P -F '#{window_id} #{pane_id}' -t "=$sess:$idx" -n "$wname" -c "$cwd" 2>/dev/null 9>&- ||
        tmux new-window -d -P -F '#{window_id} #{pane_id}' -t "=$sess:" -n "$wname" -c "$cwd" 9>&-)
    fi
    [[ $tab == @* && $pane == %* ]] || { result failed "could not open a tmux window in session $sess"; continue; }
    [[ -n $tag ]] && tmux set-option -w -t "$tab" @issuechan_agent "$tag"
    started=$SECONDS
    tmux send-keys -t "$pane" -l "$line"; tmux send-keys -t "$pane" Enter
    p_read() { tmux capture-pane -p -t "$pane"; }
    p_key() { case $1 in enter) tmux send-keys -t "$pane" Enter ;; down) tmux send-keys -t "$pane" Down ;; esac; }
    p_wait() { sleep 1; }
    if ! why=$(launch_ready p_read p_key p_wait "$timeout"); then
      tmux kill-window -t "$tab"; result failed "$(head -1 <<<"$why"), window closed"; continue
    fi
    status=ok
    if [[ -n $verify ]]; then
      local subs j ok repo issue missing
      subs=$(jq -c '.subscriptions[]' <<<"$a")
      while :; do
        missing=''
        while read -r j; do
          [[ -n $j ]] || continue
          repo=$(jq -r .repo <<<"$j") issue=$(jq -r .issue <<<"$j")
          registered "$repo" "$issue" "$name" $((SECONDS - started + 5)); ok=$?
          ((ok == 2)) && { missing=noserver; break; }
          ((ok == 0)) || missing+=" $repo#$issue"
        done <<<"$subs"
        [[ -z $missing || $missing == noserver ]] && break
        ((SECONDS - started < timeout)) || break
        sleep 3
      done
      if [[ $missing == noserver ]]; then status='ok (not verified: no server URL)'
      elif [[ -n $missing ]]; then
        tmux kill-window -t "$tab"; result failed "not registered on${missing} within ${timeout}s, window closed"; continue
      fi
    fi
    result "$status"
  done
  jq . <<<"$results"
  ! jq -e 'any(.status == "failed")' <<<"$results" >/dev/null
}

status() {
  load
  local live
  live=$(live_sessions | jq -Rsc 'split("\n") | map(select(. != ""))')
  jq --argjson live "$live" '{snapshot: .saved_at,
    agents: [.agents[] | {name, session_id, running: (.session_id as $s | $live | index($s) != null)}],
    not_in_snapshot: ([.agents[].session_id] as $saved | [$live[] | select(. as $s | $saved | index($s) | not)])}' "$snap"
}

case $cmd in
  snapshot) snapshot ;;
  recover) recover ;;
  status) status ;;
  ''|-h|--help) usage ;;
  *) die "unknown command: $cmd (snapshot, recover or status)" ;;
esac
