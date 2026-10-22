#!/usr/bin/env bash
# Spawn a Claude Code agent in a new herdr tab or tmux window and have it listen to a GitHub or Linear issue.
#
# The launch rules live here so agents don't have to remember them:
#   - only in a new herdr tab or tmux window (never a split pane or a background shell)
#   - only `$ISSUECHAN_LAUNCHER --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan`
#     (ISSUECHAN_LAUNCHER defaults to `claude`; set it to a wrapper if you use one. Never `-p`, which can't load channels)
#
# Usage: spawn-agent.sh --name <name> --issue <owner/repo#n | linear:TEAM#n> [--resume <session-id>]
#                       [--task <text>] [--cwd <dir>] [--timeout <s>] [--mux herdr|tmux]
# --mux defaults to herdr inside a herdr pane (HERDR_ENV=1), else tmux inside tmux ($TMUX).
# Prints JSON: {"name", "tab", "pane", "issue", "reply", "agent"} (tmux: tab is the window id, pane the pane id).
# On failure the new tab is closed again, so a failed spawn leaves no half-started agent behind;
# a retry under the same name is safe.
set -euo pipefail

launcher=${ISSUECHAN_LAUNCHER:-claude}

die() { echo "spawn-agent: $*" >&2; exit 1; }
# Set once the tab exists: a failure after that closes it, so the agent can't come up later unseen.
tab=''
cleanup() { [[ -n $tab ]] && mux_close >/dev/null 2>&1 && echo "spawn-agent: closed tab $tab" >&2; }
trap 'rc=$?; ((rc)) && cleanup; exit $rc' EXIT
usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

name='' issue='' resume='' task='' cwd=$PWD timeout=180 mux=''
while (($#)); do
  case $1 in
    --name) name=$2; shift 2 ;;
    --issue) issue=$2; shift 2 ;;
    --resume) resume=$2; shift 2 ;;
    --task) task=$2; shift 2 ;;
    --cwd) cwd=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --mux) mux=$2; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# Pane-manager backends: the same steps in a herdr tab or a tmux window.
if [[ -z $mux ]]; then
  if [[ ${HERDR_ENV:-} == 1 ]]; then mux=herdr; elif [[ -n ${TMUX:-} ]]; then mux=tmux; else
    die "not running inside a herdr pane (HERDR_ENV != 1) or tmux (\$TMUX unset)"; fi
fi
case $mux in
  herdr)
    [[ ${HERDR_ENV:-} == 1 ]] || die "not running inside a herdr pane (HERDR_ENV != 1)"
    mux_taken() { herdr agent get "$name" >/dev/null 2>&1; }
    mux_open() {
      local created
      created=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$cwd" --label "$name" --no-focus)
      tab=$(jq -r .result.tab.tab_id <<<"$created") pane=$(jq -r .result.root_pane.pane_id <<<"$created")
      [[ $tab == w* && $pane == w* ]] || die "tab create failed: $created"
    }
    mux_close() { herdr tab close "$tab"; }
    mux_run() { herdr pane run "$pane" "$1" >/dev/null; }
    mux_read() { herdr pane read "$pane" --source visible --lines 60; }
    mux_key() { herdr pane send-keys "$pane" "$1" >/dev/null; }
    mux_wait() { herdr pane wait-output "$pane" --regex "$1" --timeout 2000 >/dev/null 2>&1 || true; }
    mux_sleep() { herdr pane wait-output "$pane" --match '__never__' --timeout "$1" >/dev/null 2>&1 || true; }
    mux_name() {
      # Herdr needs a moment to recognize the agent before it can be named.
      for _ in $(seq 1 20); do
        herdr agent rename "$pane" "$name" >/dev/null 2>&1 && break
        mux_sleep 500
      done
      herdr agent get "$name" >/dev/null 2>&1 || die "herdr did not recognize claude in pane $pane"
    }
    # $1 prompt, $2 timeout in ms (empty: don't wait for the agent to go idle)
    mux_prompt() { herdr agent prompt "$name" "$1" ${2:+--wait --timeout "$2"} >/dev/null; }
    ;;
  tmux)
    [[ -n ${TMUX:-} ]] || die "not running inside tmux (\$TMUX unset)"
    # A window counts as this agent's while it carries @issuechan_agent=<name> and runs something other
    # than a shell (claude exited back to its shell, or crashed: the name is free again).
    mux_taken() {
      tmux list-windows -a -F '#{@issuechan_agent}	#{pane_current_command}' |
        awk -F'\t' -v n="$name" '$1 == n && $2 !~ /^-?(ba|da|fi|k|z)?sh$/ { found = 1 } END { exit !found }'
    }
    mux_open() {
      local created
      created=$(tmux new-window -d -P -F '#{window_id} #{pane_id}' -n "$name" -c "$cwd")
      read -r tab pane <<<"$created"
      [[ $tab == @* && $pane == %* ]] || die "new-window failed: $created"
      tmux set-option -w -t "$tab" @issuechan_agent "$name"
    }
    mux_close() { tmux kill-window -t "$tab"; }
    mux_run() { tmux send-keys -t "$pane" -l "$1"; tmux send-keys -t "$pane" Enter; }
    mux_read() { tmux capture-pane -p -t "$pane"; }
    mux_key() { case $1 in enter) tmux send-keys -t "$pane" Enter ;; down) tmux send-keys -t "$pane" Down ;; esac; }
    mux_wait() { sleep 1; }
    mux_sleep() { sleep "$(($1 / 1000)).$(printf '%03d' $(($1 % 1000)))"; }
    mux_name() { :; } # the window is named at creation
    # Bracketed paste, so a multi-line prompt arrives as one message; tmux can't tell when the agent is idle,
    # so the timeout is ignored and the caller's reply check does the waiting.
    mux_prompt() {
      printf '%s' "$1" | tmux load-buffer -b "issuechan-$name" -
      tmux paste-buffer -p -r -d -b "issuechan-$name" -t "$pane"
      sleep 0.5
      tmux send-keys -t "$pane" Enter
    }
    ;;
  *) die "--mux must be herdr or tmux" ;;
esac
[[ $name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--name must match [a-z][a-z0-9_-]{0,31}"
if [[ $issue =~ ^linear:([A-Z][A-Z0-9]*)#([0-9]+)$ ]]; then
  repo=linear:${BASH_REMATCH[1]} number=${BASH_REMATCH[2]} where="Linear issue ${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"
  linear="node $(dirname "$(readlink -f "$0")")/../skills/issue-channel/scripts/linear.mjs"
  checker=node
elif [[ $issue =~ ^([^/#[:space:]]+/[^/#[:space:]]+)#([0-9]+)$ ]]; then
  repo=${BASH_REMATCH[1]} number=${BASH_REMATCH[2]} where="GitHub issue $repo#$number" checker=gh
else
  die "--issue must look like owner/repo#123 or linear:TEAM#123"
fi
for bin in "$mux" "$launcher" "$checker" jq; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done
[[ -d $cwd ]] || die "--cwd $cwd is not a directory"
[[ -z $resume || $resume =~ ^[0-9a-f-]{36}$ ]] || die "--resume must be a session uuid"
if mux_taken; then die "an agent named $name is already running"; fi

# A new tab per agent: split panes keep shrinking as agents pile up.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pane=''
mux_open

cmd="$launcher"' --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan'
[[ -n $resume ]] && cmd+=" --resume $resume"
mux_run "$cmd"

# Startup dialogs. Answer only the ones we know; stop on anything else.
read_screen() { mux_read; }
deadline=$((SECONDS + 90))
while :; do
  s=$(read_screen)
  if grep -q 'bypass permissions on' <<<"$s" && ! grep -q 'Enter to confirm' <<<"$s"; then
    break
  elif grep -q 'I am using this for local development' <<<"$s"; then
    mux_key enter # option 1 is preselected
  elif grep -q '❯ No, exit' <<<"$s"; then
    mux_key down # Claude Code 2.1.284 preselects "No, exit" in a new folder
  elif grep -qE 'Yes, I trust this folder|trust the files in this folder' <<<"$s"; then
    mux_key enter # "Yes, I trust this folder" is selected
  elif grep -q 'Enter to confirm' <<<"$s"; then
    die "unknown startup dialog in pane $pane, answer it by hand:"$'\n'"$s"
  fi
  ((SECONDS < deadline)) || die "$launcher did not become ready in pane $pane:"$'\n'"$s"
  # Wait until the screen changes (or a short timeout) before looking again.
  mux_wait 'bypass permissions on|Enter to confirm'
done

mux_name

prompt="Subscribe with issuechan to the $where using session name \"$name\" (issue_subscribe with repo=\"$repo\", issue=$number, session=\"$name\"), confirm it is listed with issue_subscriptions, then post a short reply on the issue with issue_reply (done=false) saying you are listening as session $name and that '/bot $name <message>' reaches you."
# The prompt timing out is not the verdict (the agent may still finish): the verdict is its own reply on the issue,
# matched by the "🤖 <name> · cc:<id> ·" prefix, so another agent's reply on the same issue can't stand in for it.
mux_prompt "$prompt" $((timeout * 1000)) ||
  echo "spawn-agent: agent $name still busy after ${timeout}s, checking the issue" >&2
# Both providers are normalized to [{url, body}] (bot-marked comments since the launch), then matched the same way.
own_reply() {
  if [[ $checker == node ]]; then
    $linear issue "${repo#linear:}-$number" --json | jq -c --arg t "$started" \
      '.url as $u | [.comments[] | select(.createdAt >= $t and (.body | contains("issue-channel:bot")))
       | {url: "\($u)#comment-\(.id[:8])", body}]'
  else
    gh api "repos/$repo/issues/$number/comments?since=$started&per_page=100" |
      jq -c '[.[] | select(.body | contains("<!-- issue-channel:bot -->")) | {url: .html_url, body}]'
  fi | jq -c --arg p "🤖 $name · " '[.[] | select(.body | startswith($p))] | last
    | if . then {url, agent: (try (.body | capture("^🤖 [^ ]+ · (?<a>[a-z]+:[0-9a-f]{8}) ·").a) catch null)} else empty end'
}
found='' grace=$((SECONDS + 60))
[[ $mux == tmux ]] && grace=$((grace + timeout)) # the prompt above didn't wait
while :; do
  found=$(own_reply) && [[ -n $found ]] && break
  ((SECONDS < grace)) || die "no listening reply from session $name on $issue; last screen of pane $pane:"$'\n'"$(read_screen | tail -25)"
  mux_sleep 3000
done
reply=$(jq -r .url <<<"$found") agent=$(jq -r '.agent // empty' <<<"$found")

[[ -n $task ]] && mux_prompt "$task"
tab_out=$tab tab='' # spawned: keep the tab from here on

jq -n --arg name "$name" --arg tab "$tab_out" --arg pane "$pane" --arg issue "$repo#$number" --arg reply "$reply" --arg agent "$agent" \
  '{name: $name, tab: $tab, pane: $pane, issue: $issue, reply: $reply, agent: $agent}'
