#!/usr/bin/env bash
# Restart a Claude Code agent IN PLACE (same herdr or tmux pane), optionally into a CLM-compacted fork of its session.
#
#   restart-agent.sh --pane <pane> --session <id> [--fork <live-context.md> [--keep-last] | --no-compact]
#                    [--then <prompt>] [--name <herdr name>] [--wait-idle <s>] [--mux herdr|tmux] [--launcher <cmd>]
#
#   plain:   /exit, then the agent's own start command + `--resume <id>` in the same pane: same session, same context,
#            the channel restarts with the current code and resumes its subscriptions.
#   pane:    a herdr pane id (w1:p2) or a tmux pane id (%7); --mux defaults to tmux for %… ids, else herdr.
#   launcher: read from the running agent's process (spawn/launch.sh), so an agent started with `clauded` (or any
#            wrapper, with its options and env settings) comes back with `clauded`, a plain `claude` with `claude`.
#            --launcher, then $ISSUECHAN_LAUNCHER, then `claude` are used only when that can't be read.
#   --fork:  the agent first runs `session-fork mirror --full` on its own session and EDITS that file (CLM: it
#            still has its whole context when it decides). Only such an edited live-context file is accepted.
#            session-fork `fork <id> <file>` + `handoff <id> <fork>` run first, then the FORK resumes in the same
#            pane: the edited context continues there, with the subscriptions, cursors and open requests.
#            A stale file (the session moved on since the mirror) is refused. The edit report is <file>.diff.md.
#            The parent's issuechan state is moved aside (cc-<id>.json.handed-off) so it can't double-listen.
#            The session's LAST turn is always dropped: it's the turn that ran `mirror` and did the edit, and the
#            mirror output quotes the very blocks the edit drops (seen live: a dropped secret survived that way).
#            --keep-last keeps it.
#   --no-compact: like --fork, but no edit and no model work: `session-fork reset` writes a fork that keeps no
#            turn, only a note with the old log's path, how to read it back, and the last exchange verbatim. For a
#            big session idle past the prompt-cache TTL, so its next request doesn't re-read the whole context.
#            The old session is untouched (`--resume <old id>` is the rollback). Triggered by `/bot !no-compact`.
#   --then:  prompt sent to the agent once it's back (it knows nothing about the restart otherwise).
#
# Run it DETACHED when an agent restarts itself (its own turn has to end first):
#   setsid nohup restart-agent.sh --pane "${HERDR_PANE_ID:-$TMUX_PANE}" --session "$CLAUDE_CODE_SESSION_ID" … >log 2>&1 </dev/null &
# Prints JSON on success: {"pane", "from", "session", "forked", "launch", "channel_pid", "seconds"}.
# Claude Code only for now; Codex and pi support is planned (BACKLOG.md).
set -uo pipefail
shopt -s extglob

die() { echo "restart-agent: $*" >&2; exit 1; }
usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
log() { echo "[$(date -u +%T)] $*" >&2; }

pane='' sid='' plan='' then='' name='' wait_idle=1800 keep_last='' reset='' mux='' launcher=''
while (($#)); do
  case $1 in
    --pane) pane=$2; shift 2 ;;
    --session) sid=$2; shift 2 ;;
    --fork) plan=$2; shift 2 ;;
    --then) then=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    --wait-idle) wait_idle=$2; shift 2 ;;
    --keep-last) keep_last=1; shift ;;
    --no-compact) reset=1; shift ;;
    --mux) mux=$2; shift 2 ;;
    --launcher) launcher=$2; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
STATE_DIR=${ISSUECHAN_STATE_DIR:-$HOME/.local/state/issue-channel}
[[ -n $pane && $sid =~ ^[0-9a-f-]{36}$ ]] || die "--pane and --session <uuid> are required"
[[ -z $plan || -z $reset ]] || die "--fork and --no-compact exclude each other"
[[ -z $plan || -f $plan ]] || die "--fork: no such file: $plan"
[[ -z $plan ]] || [[ $(head -c 15 "$plan") == '[[LIVE_CONTEXT ' ]] \
  || die "--fork needs an edited live-context file from 'session-fork.mjs mirror --full' (a plan.json is not accepted)"
[[ -n $mux ]] || { [[ $pane == %* ]] && mux=tmux || mux=herdr; }

# One restart per pane at a time: a second one would type into the agent the first one just resumed.
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/restart-${pane//[^A-Za-z0-9]/_}.lock"
flock -n 9 || die "another restart is already running for pane $pane"

# Only ever /exit the agent this restart is for. A wrong --pane, or a --session that isn't running (a test
# fixture, a stale id), would otherwise exit whatever agent sits in that pane and resume something else there.
. "$HERE/launch.sh"
agent_pid=$(launch_agent_pid "$sid") || die "no running Claude Code process for session $sid; nothing to restart"
started=$SECONDS

# Pane backends. status prints idle, busy or gone (no agent process in the pane any more).
case $mux in
  herdr)
    status() { herdr agent get "$pane" 2>/dev/null | jq -r '.result.agent.agent_status // "gone"' 2>/dev/null || echo gone; }
    p_read() { herdr pane read "$pane" --source visible --lines "${1:-60}" 2>/dev/null; }
    p_key() { herdr pane send-keys "$pane" "$1" >/dev/null; }
    p_text() { herdr pane send-text "$pane" "$1" >/dev/null; }
    p_run() { herdr pane run "$pane" "$1" >/dev/null; }
    p_rename() { herdr agent rename "$pane" "$1" >/dev/null 2>&1; }
    p_prompt() { herdr agent prompt "$pane" "$1" >/dev/null; }
    [[ -z $name ]] && name=$(herdr agent get "$pane" 2>/dev/null | jq -r '.result.agent.name // empty' 2>/dev/null)
    ;;
  tmux)
    [[ $pane == %* ]] || die "--mux tmux needs a tmux pane id like %7"
    # No agent status in tmux: an agent is running while the pane's shell has a child; it is busy while
    # Claude Code's footer offers "esc to interrupt", idle when only the prompt footer shows.
    status() {
      local shell; shell=$(tmux display -p -t "$pane" '#{pane_pid}' 2>/dev/null) || { echo gone; return; }
      pgrep -P "$shell" >/dev/null || { echo gone; return; }
      local s; s=$(p_read)
      if grep -q 'esc to interrupt' <<<"$s"; then echo busy
      elif grep -q 'bypass permissions on' <<<"$s"; then echo idle
      else echo busy; fi
    }
    p_read() { tmux capture-pane -p -t "$pane" 2>/dev/null | grep -v '^\s*$' | tail -n "${1:-60}"; }
    p_key() { case $1 in escape) tmux send-keys -t "$pane" Escape ;; enter) tmux send-keys -t "$pane" Enter ;; down) tmux send-keys -t "$pane" Down ;; esac; }
    p_text() { tmux send-keys -t "$pane" -l "$1"; }
    p_run() { tmux send-keys -t "$pane" -l "$1"; tmux send-keys -t "$pane" Enter; }
    p_rename() { :; } # tmux windows keep their name
    p_prompt() { # bracketed paste: a multi-line prompt stays one message
      printf '%s' "$1" | tmux load-buffer -b "issuechan-restart" - && tmux paste-buffer -p -r -d -b issuechan-restart -t "$pane"
      sleep 0.5; tmux send-keys -t "$pane" Enter
    }
    ;;
  *) die "--mux must be herdr or tmux" ;;
esac
for bin in "$mux" jq node; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done
if [[ $mux == tmux ]]; then
  shell=$(tmux display -p -t "$pane" '#{pane_pid}' 2>/dev/null) || die "no tmux pane $pane"
  p=$agent_pid; while [[ -n $p ]] && ((p > 1)) && [[ $p != "$shell" ]]; do p=$(_launch_ppid "$p"); done
  [[ $p == "$shell" ]] || die "session $sid (pid $agent_pid) does not run in tmux pane $pane"
fi

# The start command, read now while the agent still runs: clauded stays clauded, claude stays claude.
if launch_detect "$sid"; then
  log "launcher: $(launch_cmd) (read from pid $LAUNCH_PID)"
else
  if [[ -n $launcher ]]; then src=--launcher; elif [[ -n ${ISSUECHAN_LAUNCHER:-} ]]; then src=ISSUECHAN_LAUNCHER; else src=default; fi
  launch_fallback "${launcher:-${ISSUECHAN_LAUNCHER:-claude}}"
  log "launcher: $(launch_cmd) (could not read the agent's start command; using $src)"
fi
[[ -n $launcher && -n $LAUNCH_PID ]] && log "note: --launcher is ignored, the agent's own start command wins"
command -v "${LAUNCH_ARGV[0]}" >/dev/null || die "${LAUNCH_ARGV[0]} not found in PATH"


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
elif [[ -n $reset ]]; then
  # From outside the session: its last turn is complete (it is idle), so nothing is treated as running.
  out=$(CLAUDE_CODE_SESSION_ID='' node "$ROOT/session-fork/session-fork.mjs" reset "$sid" ${name:+--title "$name"} 2>&1) \
    || die "session-fork reset failed: $out"
  target=$(jq -r .id <<<"$out")
  [[ $target =~ ^[0-9a-f-]{36}$ ]] || die "session-fork reset printed no id: $out"
  log "no-compact: $sid -> $target (estimate ~$(jq -r .before <<<"$out") -> ~$(jq -r .tokens <<<"$out") tokens; not API usage)"
fi
forked=''; [[ $target != "$sid" ]] && forked=1

# 3. Exit the running session and wait until its process is gone. A dialog or overlay left open after the turn
#    (seen live: a feedback prompt) swallows typed text, so close it with Escape first and retry a few times.
for attempt in 1 2 3; do
  p_key escape; sleep 1
  p_text "/exit"; sleep 1; p_key enter
  for i in $(seq 1 20); do [[ $(status) == gone ]] && break 2; sleep 1; done
  log "exit attempt $attempt: still running; screen:"$'\n'"$(p_read 15 | grep -v '^\s*$' | tail -8)"
done
# Nothing was handed over yet, so the running session keeps its subscriptions when this fails.
[[ $(status) == gone ]] || die "agent in $pane did not exit; its session and issuechan state are untouched${forked:+ (fork $target is unused)}"
log "exited"
sleep 2

# 4. Hand the issuechan state to the fork, now that the parent can no longer change it.
if [[ -n $forked && -f $STATE_DIR/cc-$sid.json ]]; then
  node "$ROOT/session-fork/session-fork.mjs" handoff "$sid" "$target" >/dev/null || die "handoff failed"
  mv "$STATE_DIR/cc-$sid.json" "$STATE_DIR/cc-$sid.json.handed-off"
  log "issuechan state handed to $target"
fi

# 5. Resume in the same pane, answering only the known startup dialogs.
p_run "$(launch_cmd --resume "$target")"
ready=''
for i in $(seq 1 45); do
  s=$(p_read)
  if grep -q 'I am using this for local development' <<<"$s"; then p_key enter
  elif grep -q '❯ No, exit' <<<"$s"; then p_key down # preselected in a new folder
  elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then p_key enter
  elif grep -q 'bypass permissions on' <<<"$s" && ! grep -q 'Enter to confirm' <<<"$s"; then ready=1; break
  elif grep -q 'Enter to confirm' <<<"$s"; then die "unknown startup dialog in $pane, answer it by hand"
  fi
  sleep 2
done
[[ -n $ready ]] || die "session $target did not become ready in $pane"
for i in $(seq 1 20); do [[ $(status) != gone ]] && break; sleep 1; done
[[ -n $name ]] && p_rename "$name"

# 6. Verify: exactly one issuechan channel process for the resumed session.
pid=''
for i in $(seq 1 20); do
  for p in $(pgrep -f 'adapters/claude-code/channel.mjs'); do
    [[ $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -d' ' -f1) == ?(*/)node ]] || continue # node or /path/to/node
    tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -qx "CLAUDE_CODE_SESSION_ID=$target" && pid=$p
  done
  [[ -n $pid ]] && break; sleep 1
done
[[ -n $pid ]] || log "warning: no issuechan channel process found for $target"
log "resumed $target (channel pid ${pid:-?})"

# 7. Tell the agent what happened and what to do next.
[[ -n $then ]] && p_prompt "$then"

jq -nc --arg pane "$pane" --arg from "$sid" --arg session "$target" --argjson forked "$([[ -n $forked ]] && echo true || echo false)" --argjson reset "$([[ -n $reset ]] && echo true || echo false)" --argjson edit "$([[ -n $plan ]] && jq -c '{kept, blocks, edited, dropped, notes, handoff, diff}' <<<"$out" || echo null)" \
  --arg launch "$(launch_cmd --resume "$target")" --arg pid "${pid:-}" --argjson seconds $((SECONDS - started)) \
  '{pane: $pane, from: $from, session: $session, forked: $forked, reset: $reset, edit: $edit, launch: $launch, channel_pid: $pid, seconds: $seconds}'
