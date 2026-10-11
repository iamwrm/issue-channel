#!/usr/bin/env bash
# Restart a Claude Code agent IN PLACE (same herdr pane), optionally into a CLM-compacted fork of its session.
#
#   restart-agent.sh --pane <pane> --session <id> [--fork <live-context.md> [--keep-last]] [--then <prompt>]
#                    [--name <herdr name>] [--wait-idle <s>]
#
#   plain:   /exit, then `$ISSUECHAN_LAUNCHER … --resume <id>` in the same pane: same session, same context,
#            the channel restarts with the current code and resumes its subscriptions.
#   --fork:  the agent first runs `session-fork mirror --full` on its own session and EDITS that file (CLM: it
#            still has its whole context when it decides). Only such an edited live-context file is accepted.
#            session-fork `fork <id> <file>` + `handoff <id> <fork>` run first, then the FORK resumes in the same
#            pane: the edited context continues there, with the subscriptions, cursors and open requests.
#            A stale file (the session moved on since the mirror) is refused. The edit report is <file>.diff.md.
#            The parent's issuechan state is moved aside (cc-<id>.json.handed-off) so it can't double-listen.
#            The session's LAST turn is always dropped: it's the turn that ran `mirror` and did the edit, and the
#            mirror output quotes the very blocks the edit drops (seen live: a dropped secret survived that way).
#            --keep-last keeps it.
#   --then:  prompt sent to the agent once it's back (it knows nothing about the restart otherwise).
#
# Run it DETACHED when an agent restarts itself (its own turn has to end first):
#   setsid nohup restart-agent.sh --pane "$HERDR_PANE_ID" --session "$CLAUDE_CODE_SESSION_ID" … >log 2>&1 </dev/null &
# Prints JSON on success: {"pane", "from", "session", "forked", "channel_pid", "seconds"}.
# Claude Code only for now; Codex and pi support is planned (BACKLOG.md).
set -uo pipefail

die() { echo "restart-agent: $*" >&2; exit 1; }
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
log() { echo "[$(date -u +%T)] $*" >&2; }

pane='' sid='' plan='' then='' name='' wait_idle=1800 keep_last=''
while (($#)); do
  case $1 in
    --pane) pane=$2; shift 2 ;;
    --session) sid=$2; shift 2 ;;
    --fork) plan=$2; shift 2 ;;
    --then) then=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --wait-idle) wait_idle=$2; shift 2 ;;
    --keep-last) keep_last=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
launcher=${ISSUECHAN_LAUNCHER:-claude}
STATE_DIR=${ISSUECHAN_STATE_DIR:-$HOME/.local/state/issue-channel}
[[ -n $pane && $sid =~ ^[0-9a-f-]{36}$ ]] || die "--pane and --session <uuid> are required"
[[ -z $plan || -f $plan ]] || die "--fork: no such file: $plan"
[[ -z $plan ]] || [[ $(head -c 15 "$plan") == '[[LIVE_CONTEXT ' ]] \
  || die "--fork needs an edited live-context file from 'session-fork.mjs mirror --full' (a plan.json is not accepted)"
for bin in herdr jq node "$launcher"; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done
started=$SECONDS

status() { herdr agent get "$pane" 2>/dev/null | jq -r '.result.agent.agent_status // "gone"' 2>/dev/null || echo gone; }
[[ -z $name ]] && name=$(herdr agent get "$pane" 2>/dev/null | jq -r '.result.agent.name // empty' 2>/dev/null)

# One restart per pane at a time: a second one would type into the agent the first one just resumed.
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/restart-${pane//[^A-Za-z0-9]/_}.lock"
flock -n 9 || die "another restart is already running for pane $pane"

# 1. Never interrupt a turn: wait until the agent is idle.
for ((i = 0; i < wait_idle; i += 2)); do st=$(status); [[ $st == idle || $st == done ]] && break; sleep 2; done
[[ $st == idle || $st == done ]] || die "agent in $pane not idle after ${wait_idle}s (status $st)"
log "agent idle"

# 2. Compact: fork the session log by the edited file (a bad edit fails here, before anything is stopped).
target=$sid
if [[ -n $plan ]]; then
  # A mirror the agent made of itself (self=1) left out its running turn, the one doing the edit: claim the
  # session's id so session-fork drops that turn too. A mirror made from outside (self=0) covers every turn.
  self=''; [[ $(head -1 "$plan") == *' self=1 '* ]] && self=$sid
  out=$(CLAUDE_CODE_SESSION_ID=$self node "$ROOT/session-fork/session-fork.mjs" fork "$sid" "$plan" ${keep_last:+--keep-last} ${name:+--title "$name"} 2>&1) \
    || die "session-fork fork failed: $out"
  target=$(jq -r .id <<<"$out")
  [[ $target =~ ^[0-9a-f-]{36}$ ]] || die "session-fork fork printed no id: $out"
  log "forked $sid -> $target ($(jq -r '"estimate ~\(.before) -> ~\(.tokens) tokens (not API usage; see ctx report), \(.entries) entries; blocks kept \(.kept)/\(.blocks), edited \(.edited), dropped \(.dropped), notes \(.notes)\(if .handoff then ", HANDOFF ONLY" else "" end); \(.diff)"' <<<"$out"))"
  jq -r '.warnings[]? | "warning: " + .' <<<"$out" | while read -r w; do log "$w"; done
fi

# 3. Exit the running session and wait until its process is gone. A dialog or overlay left open after the turn
#    (seen live: a feedback prompt) swallows typed text, so close it with Escape first and retry a few times.
for attempt in 1 2 3; do
  herdr pane send-keys "$pane" escape >/dev/null; sleep 1
  herdr pane send-text "$pane" "/exit" >/dev/null; sleep 1; herdr pane send-keys "$pane" enter >/dev/null
  for i in $(seq 1 20); do [[ $(status) == gone ]] && break 2; sleep 1; done
  log "exit attempt $attempt: still running; screen:"$'\n'"$(herdr pane read "$pane" --source visible --lines 15 2>/dev/null | grep -v '^\s*$' | tail -8)"
done
# Nothing was handed over yet, so the running session keeps its subscriptions when this fails.
[[ $(status) == gone ]] || die "agent in $pane did not exit; its session and issuechan state are untouched${plan:+ (fork $target is unused)}"
log "exited"
sleep 2

# 4. Hand the issuechan state to the fork, now that the parent can no longer change it.
if [[ -n $plan && -f $STATE_DIR/cc-$sid.json ]]; then
  node "$ROOT/session-fork/session-fork.mjs" handoff "$sid" "$target" >/dev/null || die "handoff failed"
  mv "$STATE_DIR/cc-$sid.json" "$STATE_DIR/cc-$sid.json.handed-off"
  log "issuechan state handed to $target"
fi

# 5. Resume in the same pane, answering only the known startup dialogs.
herdr pane run "$pane" "$launcher --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan --resume $target" >/dev/null
ready=''
for i in $(seq 1 45); do
  s=$(herdr pane read "$pane" --source visible --lines 60 2>/dev/null)
  if grep -q 'I am using this for local development' <<<"$s"; then herdr pane send-keys "$pane" enter >/dev/null
  elif grep -q '❯ No, exit' <<<"$s"; then herdr pane send-keys "$pane" down >/dev/null # preselected in a new folder
  elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then herdr pane send-keys "$pane" enter >/dev/null
  elif grep -q 'bypass permissions on' <<<"$s" && ! grep -q 'Enter to confirm' <<<"$s"; then ready=1; break
  elif grep -q 'Enter to confirm' <<<"$s"; then die "unknown startup dialog in $pane, answer it by hand"
  fi
  sleep 2
done
[[ -n $ready ]] || die "session $target did not become ready in $pane"
for i in $(seq 1 20); do [[ $(status) != gone ]] && break; sleep 1; done
[[ -n $name ]] && herdr agent rename "$pane" "$name" >/dev/null 2>&1

# 6. Verify: exactly one issuechan channel process for the resumed session.
pid=''
for i in $(seq 1 20); do
  for p in $(pgrep -f 'adapters/claude-code/channel.mjs'); do
    [[ $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -d' ' -f1) == node ]] || continue
    tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -qx "CLAUDE_CODE_SESSION_ID=$target" && pid=$p
  done
  [[ -n $pid ]] && break; sleep 1
done
[[ -n $pid ]] || log "warning: no issuechan channel process found for $target"
log "resumed $target (channel pid ${pid:-?})"

# 7. Tell the agent what happened and what to do next.
[[ -n $then ]] && herdr agent prompt "$pane" "$then" >/dev/null

jq -nc --arg pane "$pane" --arg from "$sid" --arg session "$target" --argjson forked "$([[ -n $plan ]] && echo true || echo false)" --argjson edit "$([[ -n $plan ]] && jq -c '{kept, blocks, edited, dropped, notes, handoff, diff}' <<<"$out" || echo null)" \
  --arg pid "${pid:-}" --argjson seconds $((SECONDS - started)) \
  '{pane: $pane, from: $from, session: $session, forked: $forked, edit: $edit, channel_pid: $pid, seconds: $seconds}'
